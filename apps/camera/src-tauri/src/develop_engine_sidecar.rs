//! 現像の native の sidecar（`niho-develop-render serve`。長く生きる 1 プロセス）を持つ（Issue #152 の口の仕様 4・5）。画面の
//! Worker の native glue が URI scheme `niho-develop://`（`develop_engine_scheme.rs`）へ送った要求を stdin の封にして渡し、stdout
//! の封の応答をそのまま返す。本文（JSON の header と binary）は読まずに運ぶ（読むのは `hello` の応答だけ）。
//!
//! - 起動は最初の要求で（アプリの起動時には立てない）。`develop::bundled_sidecar_paths()` の `develop_render` を `serve` で起動し、
//!   id 0 の `hello` を送って、`protocol` が 1 であることと口の一覧（`methods`）を覚える。10 秒で答えない・形が違う → 使えない
//! - 要求は多重化する: stdin への書き込みは Mutex で封ごと、stdout は reader の thread が封を読み、id で待っている側へ渡す
//!   （serve は要求を並行に処理し、応答の順は要求の順と違ってよい）
//! - 落ちた（stdout の EOF・stdin に書けない）ら、待っている要求を全部失敗にし、次の要求で起動し直す（1 分に 3 回まで。超えたら
//!   使えないまま）
//! - 1 要求の待ちは 120 秒。超えたら sidecar を止める（同じ sidecar を待っているほかの要求も失敗する）
//! - `stop()`: main 窓の読み込みとアプリの終了で sidecar を止める（Developer を全部手放す）。次の要求でまた起動する
//! - 使えないときは短い英語の理由を返す（scheme が 503 の本文にする。画面は wasm へ落ちる）。ログ（`camera.log`）には起動・
//!   `hello` の版・落ちた・起動し直しを 1 行ずつ残し、パスと写真の名前は残さない（子の stderr は読み捨て、行の数だけ残す）

use crate::develop::bundled_sidecar_paths;
use niho_desktop_photo::common::LogFn;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};
use tauri::{Manager, Runtime};

/// serve と話す封の版（`hello` の `protocol`）。
pub const PROTOCOL: u64 = 1;
/// 起動の確かめと版の口（画面の glue も呼ぶ。口の一覧に無くても通す）。
pub const HELLO: &str = "hello";
/// 起動のときの `hello` の id（画面からの要求は 1 から振る）。
const HELLO_ID: u32 = 0;
/// method の名前の上限（口の仕様 4）。
pub const MAX_METHOD_BYTES: usize = 64;
/// 要求の本文の上限（口の仕様 4。scheme はこれを超える本文を 400 にする）。
pub const MAX_BODY_BYTES: usize = 1 << 30;
/// 応答の本文の上限（原寸の RGBA・書き出しの PNG が入る。壊れた長さで大きな領域を取らない）。
const MAX_REPLY_BYTES: u64 = 2 << 30;
/// 起動し直しを数える間と、その間の上限。
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const MAX_RESTARTS: usize = 3;
/// ログに残す `hello` の `tool`（版の 1 行）の長さの上限。
const MAX_TOOL_CHARS: usize = 120;

/// sidecar を使えない理由（scheme の 503 の本文。短い英語の 1 行で、パスは入れない）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unavailable(pub &'static str);

pub const NOT_BUNDLED: Unavailable = Unavailable("develop sidecar is not bundled");
pub const SPAWN_FAILED: Unavailable = Unavailable("develop sidecar could not start");
pub const HELLO_TIMED_OUT: Unavailable = Unavailable("develop sidecar did not answer hello");
pub const HELLO_INVALID: Unavailable = Unavailable("develop sidecar answered an unexpected hello");
pub const PROTOCOL_MISMATCH: Unavailable = Unavailable("develop sidecar speaks another protocol");
pub const RESTART_LIMIT: Unavailable = Unavailable("develop sidecar restarted too often");
pub const EXITED: Unavailable = Unavailable("develop sidecar exited");
pub const TIMED_OUT: Unavailable = Unavailable("develop sidecar timed out");
pub const STOPPED: Unavailable = Unavailable("develop sidecar was stopped");
pub const STALE_CLIENT: Unavailable = Unavailable("develop sidecar was restarted for another client");

/// 要求が通らなかったわけ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallError {
  /// sidecar を使えない（503）
  Unavailable(Unavailable),
  /// `hello` の口の一覧に無い method（404）
  UnknownMethod,
}

/// 待ちの上限。
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
  /// 起動してから `hello` に答えるまで
  pub hello: Duration,
  /// 1 要求の応答まで（超えたら sidecar を止める）
  pub request: Duration,
}

impl Default for Timeouts {
  fn default() -> Self {
    Self {
      hello: Duration::from_secs(10),
      request: Duration::from_secs(120),
    }
  }
}

/// 子プロセス（試験では偽の serve）を止める口。
pub trait Process: Send {
  /// 止めて、終わるのを待つ。終わり方（exit code・signal）を返す。
  fn terminate(&mut self) -> Value;
}

impl Process for Child {
  fn terminate(&mut self) -> Value {
    let _ = self.kill();
    match self.wait() {
      Ok(status) => json!({ "exitCode": status.code(), "signal": status.signal() }),
      Err(_) => Value::Null,
    }
  }
}

/// 起動した serve とつながる口（試験では `UnixStream::pair()` の片方を差し込む）。
pub struct Connection {
  pub reader: Box<dyn Read + Send>,
  pub writer: Box<dyn Write + Send>,
  pub process: Box<dyn Process>,
}

/// serve を起動する。
pub type Spawn = Arc<dyn Fn() -> Result<Connection, Unavailable> + Send + Sync>;
/// 今の時刻（起動し直しの回数を数える。試験で差し替える）。
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

/// `[A-Za-z.]{1,64}`（URL の path と stdin の封に入れてよい method の名前）。
pub fn is_method_name(name: &str) -> bool {
  !name.is_empty()
    && name.len() <= MAX_METHOD_BYTES
    && name.bytes().all(|byte| byte.is_ascii_alphabetic() || byte == b'.')
}

/// stdin の 1 要求: `u32 LE id · u32 LE M · M bytes method · u32 LE B · B bytes 本文`。
pub fn write_request<W: Write + ?Sized>(writer: &mut W, id: u32, method: &str, body: &[u8]) -> io::Result<()> {
  if !is_method_name(method) || body.len() > MAX_BODY_BYTES {
    return Err(io::Error::from(io::ErrorKind::InvalidInput));
  }
  let mut head = Vec::with_capacity(12 + method.len());
  head.extend_from_slice(&id.to_le_bytes());
  head.extend_from_slice(&(method.len() as u32).to_le_bytes());
  head.extend_from_slice(method.as_bytes());
  head.extend_from_slice(&(body.len() as u32).to_le_bytes());
  writer.write_all(&head)?;
  writer.write_all(body)?;
  writer.flush()
}

fn read_u32<R: Read + ?Sized>(reader: &mut R) -> io::Result<u32> {
  let mut bytes = [0u8; 4];
  reader.read_exact(&mut bytes)?;
  Ok(u32::from_le_bytes(bytes))
}

/// stdout の 1 応答: `u32 LE id · u32 LE B · B bytes 本文`。読み切れない・上限を超える → Err（serve は落ちた扱い）。
pub fn read_reply<R: Read + ?Sized>(reader: &mut R) -> io::Result<(u32, Vec<u8>)> {
  let id = read_u32(reader)?;
  let length = u64::from(read_u32(reader)?);
  if length > MAX_REPLY_BYTES {
    return Err(io::Error::from(io::ErrorKind::InvalidData));
  }
  let mut body = Vec::new();
  body
    .try_reserve_exact(length as usize)
    .map_err(|_| io::Error::from(io::ErrorKind::OutOfMemory))?;
  Read::take(reader, length).read_to_end(&mut body)?;
  if body.len() as u64 != length {
    return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
  }
  Ok((id, body))
}

/// 本文: `u32 LE H · H bytes header（JSON） · payload`。
fn body_with_header(header: &[u8]) -> Vec<u8> {
  let mut body = Vec::with_capacity(4 + header.len());
  body.extend_from_slice(&(header.len() as u32).to_le_bytes());
  body.extend_from_slice(header);
  body
}

/// 起動のときに送る `hello` の本文（引数なし）。
pub fn hello_request_body() -> Vec<u8> {
  body_with_header(br#"{"args":[],"blobs":[]}"#)
}

/// `hello` の結果（口の仕様 3）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
  pub tool: String,
  pub crate_version: String,
  pub engine: String,
  pub threads: u64,
  pub methods: Vec<String>,
}

/// `hello` の応答の本文を読む（`{"ok":true,"result":{...}}`。protocol が 1 でない・形が違う → 使えない）。
pub fn parse_hello(body: &[u8]) -> Result<Hello, Unavailable> {
  let length = u32::from_le_bytes(
    body
      .get(..4)
      .ok_or(HELLO_INVALID)?
      .try_into()
      .map_err(|_| HELLO_INVALID)?,
  );
  let header = 4usize
    .checked_add(length as usize)
    .and_then(|end| body.get(4..end))
    .ok_or(HELLO_INVALID)?;
  let envelope: Value = serde_json::from_slice(header).map_err(|_| HELLO_INVALID)?;
  if envelope["ok"] != Value::Bool(true) {
    return Err(HELLO_INVALID);
  }
  if envelope["result"]["protocol"].as_u64() != Some(PROTOCOL) {
    return Err(PROTOCOL_MISMATCH);
  }
  let hello: Hello = serde_json::from_value(envelope["result"].clone()).map_err(|_| HELLO_INVALID)?;
  if hello.methods.is_empty() || !hello.methods.iter().all(|method| is_method_name(method)) {
    return Err(HELLO_INVALID);
  }
  Ok(hello)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

type Reply = Result<Vec<u8>, Unavailable>;

#[derive(Default)]
struct Pending {
  closed: bool,
  waiters: HashMap<u32, SyncSender<Reply>>,
}

/// sidecar が終わったわけ。
#[derive(Debug, Clone, Copy)]
enum Close {
  /// stdout の EOF・壊れた封
  Eof,
  /// stdin に書けない
  Write,
  /// 応答の待ちの上限を超えた
  Timeout,
  /// `stop()`（窓の読み込み・アプリの終了）
  Stopped,
  /// `hello` の応答が違う
  Hello,
}

impl Close {
  fn code(self) -> &'static str {
    match self {
      Close::Eof => "exited",
      Close::Write => "writeFailed",
      Close::Timeout => "timedOut",
      Close::Stopped => "stopped",
      Close::Hello => "helloRejected",
    }
  }

  fn unavailable(self) -> Unavailable {
    match self {
      Close::Timeout => TIMED_OUT,
      Close::Stopped => STOPPED,
      Close::Eof | Close::Write | Close::Hello => EXITED,
    }
  }
}

/// 起動した 1 つの serve。
struct Session {
  /// Monotonically increasing within the app process. A Worker bound to an
  /// earlier sidecar must never use a recycled numeric Developer handle.
  generation: u64,
  writer: Mutex<Box<dyn Write + Send>>,
  pending: Mutex<Pending>,
  process: Mutex<Option<Box<dyn Process>>>,
  /// `hello` が通ったら口の一覧（それまでは要求を受けない）
  methods: OnceLock<HashSet<String>>,
  next_id: AtomicU32,
  log: LogFn,
}

impl Session {
  fn new(writer: Box<dyn Write + Send>, process: Box<dyn Process>, log: LogFn, generation: u64) -> Arc<Self> {
    Arc::new(Self {
      generation,
      writer: Mutex::new(writer),
      pending: Mutex::new(Pending::default()),
      process: Mutex::new(Some(process)),
      methods: OnceLock::new(),
      next_id: AtomicU32::new(HELLO_ID + 1),
      log,
    })
  }

  fn is_ready(&self) -> bool {
    self.methods.get().is_some() && !lock(&self.pending).closed
  }

  fn knows(&self, method: &str) -> bool {
    method == HELLO || self.methods.get().is_some_and(|methods| methods.contains(method))
  }

  fn next_id(&self) -> u32 {
    loop {
      let id = self.next_id.fetch_add(1, Ordering::Relaxed);
      if id != HELLO_ID {
        return id;
      }
    }
  }

  /// 封を書いて、同じ id の応答を待つ。
  fn request(self: &Arc<Self>, id: u32, method: &str, body: &[u8], timeout: Duration) -> Reply {
    let deadline = Instant::now() + timeout;
    let (sender, receiver) = mpsc::sync_channel(1);
    {
      let mut pending = lock(&self.pending);
      if pending.closed {
        return Err(EXITED);
      }
      pending.waiters.insert(id, sender);
    }
    // The write can itself block forever when a live child stops reading its
    // pipe. A separate watchdog must own the deadline, not recv_timeout alone.
    let (cancel, canceled) = mpsc::channel::<()>();
    let session = Arc::clone(self);
    if std::thread::Builder::new()
      .name("niho-develop-serve-deadline".into())
      .spawn(move || {
        if matches!(
          canceled.recv_timeout(deadline.saturating_duration_since(Instant::now())),
          Err(RecvTimeoutError::Timeout)
        ) {
          session.close(Close::Timeout);
        }
      })
      .is_err()
    {
      self.close(Close::Timeout);
      return Err(SPAWN_FAILED);
    }
    let written = write_request(&mut **lock(&self.writer), id, method, body);
    if written.is_err() {
      self.close(Close::Write);
    }
    let result = match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
      Ok(reply) => reply,
      Err(RecvTimeoutError::Timeout) => {
        self.close(Close::Timeout);
        Err(TIMED_OUT)
      }
      Err(RecvTimeoutError::Disconnected) => Err(EXITED),
    };
    let _ = cancel.send(());
    result
  }

  /// 子を止め、待っている要求を全部失敗にする（2 回目からは何もしない）。
  fn close(&self, why: Close) {
    let waiters = {
      let mut pending = lock(&self.pending);
      if pending.closed {
        return;
      }
      pending.closed = true;
      std::mem::take(&mut pending.waiters)
    };
    let status = lock(&self.process)
      .take()
      .map(|mut process| process.terminate())
      .unwrap_or(Value::Null);
    (self.log)(
      "camera.develop_serve_exited",
      json!({ "reason": why.code(), "pending": waiters.len(), "status": status }),
    );
    for waiter in waiters.into_values() {
      let _ = waiter.send(Err(why.unavailable()));
    }
  }
}

/// stdout の封を読み、id で待っている側へ渡す（EOF・壊れた封で終わる）。
fn read_replies(session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
  loop {
    match read_reply(&mut *reader) {
      Ok((id, body)) => {
        let waiter = lock(&session.pending).waiters.remove(&id);
        if let Some(waiter) = waiter {
          let _ = waiter.send(Ok(body));
        }
      }
      Err(_) => {
        session.close(Close::Eof);
        return;
      }
    }
  }
}

#[derive(Default)]
struct State {
  /// 今の serve（起動中・`hello` 待ちも含む。落ちたら閉じたまま残り、次の起動で外す）
  current: Option<Arc<Session>>,
  /// A native glue instance is bound to the sidecar generation that answered
  /// its first hello. Keep this across child restarts and page reloads.
  clients: HashMap<String, u64>,
  next_generation: u64,
  /// 最後の `stop()`（またはアプリの起動）の後に起動したか（2 回目からは「起動し直し」として数える）
  started: bool,
  /// 起動し直した時刻（{@link RESTART_WINDOW} より古いものは捨てる）
  restarts: VecDeque<Instant>,
  /// 上限に当たったのをログに残したか（起動し直せたら戻す）
  limit_logged: bool,
}

struct Engine {
  spawn: Spawn,
  clock: Clock,
  log: LogFn,
  timeouts: Timeouts,
  state: Mutex<State>,
  /// 起動を 1 つずつにする（`state` とは別の lock。`stop()` は起動の `hello` 待ちを待たない）
  starting: Mutex<()>,
}

impl Engine {
  fn ready(&self) -> Option<Arc<Session>> {
    lock(&self.state)
      .current
      .as_ref()
      .filter(|session| session.is_ready())
      .cloned()
  }

  fn ready_session(&self) -> Result<Arc<Session>, Unavailable> {
    if let Some(session) = self.ready() {
      return Ok(session);
    }
    let _starting = lock(&self.starting);
    if let Some(session) = self.ready() {
      return Ok(session);
    }
    self.start()
  }

  fn unavailable(&self, reason: Unavailable) -> Unavailable {
    (self.log)("camera.develop_serve_unavailable", json!({ "reason": reason.0 }));
    reason
  }

  /// 起動して `hello` を送る（`starting` を持って呼ぶ）。
  fn start(&self) -> Result<Arc<Session>, Unavailable> {
    let session = {
      let mut state = lock(&self.state);
      let restart = std::mem::replace(&mut state.started, true);
      if restart {
        let now = (self.clock)();
        while state
          .restarts
          .front()
          .is_some_and(|at| now.saturating_duration_since(*at) >= RESTART_WINDOW)
        {
          state.restarts.pop_front();
        }
        if state.restarts.len() >= MAX_RESTARTS {
          if !std::mem::replace(&mut state.limit_logged, true) {
            self.unavailable(RESTART_LIMIT);
          }
          return Err(RESTART_LIMIT);
        }
        state.restarts.push_back(now);
      }
      state.limit_logged = false;
      if let Some(old) = state.current.take() {
        old.close(Close::Stopped);
      }
      let connection = (self.spawn)().map_err(|reason| self.unavailable(reason))?;
      state.next_generation = state
        .next_generation
        .checked_add(1)
        .expect("sidecar generation overflow");
      let session = Session::new(
        connection.writer,
        connection.process,
        self.log.clone(),
        state.next_generation,
      );
      let reader_session = session.clone();
      let reader = connection.reader;
      let spawned = std::thread::Builder::new()
        .name("niho-develop-serve".into())
        .spawn(move || read_replies(reader_session, reader));
      if spawned.is_err() {
        session.close(Close::Eof);
        return Err(self.unavailable(SPAWN_FAILED));
      }
      state.current = Some(session.clone());
      (self.log)(
        "camera.develop_serve_started",
        json!({ "restart": restart, "restartsInWindow": state.restarts.len() }),
      );
      session
    };

    let hello = session
      .request(HELLO_ID, HELLO, &hello_request_body(), self.timeouts.hello)
      .map_err(|reason| if reason == TIMED_OUT { HELLO_TIMED_OUT } else { reason })
      .and_then(|body| parse_hello(&body));
    let hello = match hello {
      Ok(hello) => hello,
      Err(reason) => {
        session.close(Close::Hello);
        return Err(self.unavailable(reason));
      }
    };
    let state = lock(&self.state);
    if !state
      .current
      .as_ref()
      .is_some_and(|current| Arc::ptr_eq(current, &session))
    {
      // `hello` を待つ間に止めた
      return Err(STOPPED);
    }
    (self.log)(
      "camera.develop_serve_ready",
      json!({
        "tool": hello.tool.chars().take(MAX_TOOL_CHARS).collect::<String>(),
        "crateVersion": hello.crate_version.chars().take(MAX_TOOL_CHARS).collect::<String>(),
        "engine": hello.engine.chars().take(MAX_TOOL_CHARS).collect::<String>(),
        "threads": hello.threads,
        "methods": hello.methods.len(),
      }),
    );
    let _ = session.methods.set(hello.methods.into_iter().collect());
    Ok(session)
  }
}

/// 現像の native の sidecar（`app.manage` で持つ。複製は同じ sidecar を指す）。
#[derive(Clone)]
pub struct DevelopEngine(Arc<Engine>);

impl DevelopEngine {
  pub fn new(spawn: Spawn, clock: Clock, log: LogFn, timeouts: Timeouts) -> Self {
    Self(Arc::new(Engine {
      spawn,
      clock,
      log,
      timeouts,
      state: Mutex::new(State::default()),
      starting: Mutex::new(()),
    }))
  }

  /// `.app` に同梱の `niho-develop-render`（開発ビルドは `NIHO_DEVELOP_RENDER_PATH`）を `serve` で起動する。
  pub fn bundled(log: LogFn) -> Self {
    let stderr_log = log.clone();
    let spawn: Spawn = Arc::new(move || spawn_bundled(stderr_log.clone()));
    Self::new(spawn, Arc::new(Instant::now), log, Timeouts::default())
  }

  /// method を呼ぶ（初めてなら起動と `hello` を済ませてから）。応答の本文をそのまま返す。
  pub fn call(&self, method: &str, body: &[u8]) -> Result<Vec<u8>, CallError> {
    let session = self.0.ready_session().map_err(CallError::Unavailable)?;
    if !session.knows(method) {
      return Err(CallError::UnknownMethod);
    }
    session
      .request(session.next_id(), method, body, self.0.timeouts.request)
      .map_err(CallError::Unavailable)
  }

  /// A WebView Worker's first `hello` binds its random client token to the
  /// current process. Subsequent calls from that Worker may only reach that
  /// same process, even if its numeric handles are reused after a restart.
  pub fn call_for_client(&self, client: &str, method: &str, body: &[u8]) -> Result<Vec<u8>, CallError> {
    let session = self.0.ready_session().map_err(CallError::Unavailable)?;
    {
      let mut state = lock(&self.0.state);
      match state.clients.get(client).copied() {
        Some(generation) if generation == session.generation => {}
        None if method == HELLO => {
          state.clients.insert(client.to_owned(), session.generation);
        }
        _ => return Err(CallError::Unavailable(STALE_CLIENT)),
      }
    }
    if !session.knows(method) {
      return Err(CallError::UnknownMethod);
    }
    let reply = session
      .request(session.next_id(), method, body, self.0.timeouts.request)
      .map_err(CallError::Unavailable);
    if method == "releaseClient" && reply.is_ok() {
      lock(&self.0.state).clients.remove(client);
    }
    reply
  }

  /// sidecar を止める（Developer を全部手放す。待っている要求は失敗する）。次の要求はまた起動する（起動し直しに数えない）。
  pub fn stop(&self) {
    let session = {
      let mut state = lock(&self.0.state);
      state.started = false;
      state.current.take()
    };
    if let Some(session) = session {
      session.close(Close::Stopped);
    }
  }
}

fn spawn_bundled(log: LogFn) -> Result<Connection, Unavailable> {
  let path = bundled_sidecar_paths()
    .map(|paths| paths.develop_render)
    .filter(|path| path.is_file())
    .ok_or(NOT_BUNDLED)?;
  let mut child = Command::new(path)
    .arg("serve")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| {
      if error.kind() == io::ErrorKind::NotFound {
        NOT_BUNDLED
      } else {
        SPAWN_FAILED
      }
    })?;
  let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
    child.terminate();
    return Err(SPAWN_FAILED);
  };
  drain_stderr(stderr, log);
  Ok(Connection {
    reader: Box::new(BufReader::new(stdout)),
    writer: Box::new(BufWriter::new(stdin)),
    process: Box::new(child),
  })
}

/// 子の stderr を読み捨てる（中身にパスが入りうるので残さない。行の数だけ残す）。
fn drain_stderr(mut stderr: ChildStderr, log: LogFn) {
  let _ = std::thread::Builder::new()
    .name("niho-develop-serve-stderr".into())
    .spawn(move || {
      let mut buffer = [0u8; 4096];
      let mut lines = 0usize;
      while let Ok(read @ 1..) = stderr.read(&mut buffer) {
        lines += buffer[..read].iter().filter(|byte| **byte == b'\n').count();
      }
      if lines > 0 {
        log("camera.develop_serve_stderr", json!({ "lines": lines }));
      }
    });
}

/// 起動時に 1 回（sidecar は最初の要求まで起動しない）。
pub fn install(app: &tauri::AppHandle) {
  app.manage(DevelopEngine::bundled(crate::app_log::log_fn(app)));
}

/// main 窓の読み込み・アプリの終了で sidecar を止める。
pub fn stop<R: Runtime>(app: &tauri::AppHandle<R>) {
  if let Some(engine) = app.try_state::<DevelopEngine>() {
    engine.stop();
  }
}

/// 偽の serve（`UnixStream::pair()` の片方を試験の thread が持つ）。scheme の試験も使う。
#[cfg(test)]
pub(crate) mod test_support {
  use super::*;
  use std::os::unix::net::UnixStream;
  use std::sync::atomic::AtomicUsize;

  /// 偽の serve の振る舞い: 要求（id・method・本文）ごとに、書く応答（id・本文）の並び。None なら落ちる。
  pub type Script = Box<dyn FnMut(u32, &str, &[u8]) -> Option<Vec<(u32, Vec<u8>)>> + Send>;
  pub type Events = Arc<Mutex<Vec<(String, Value)>>>;

  /// 応答の本文（`u32 LE H · header · payload`）。
  pub fn reply_body(header: Value, payload: &[u8]) -> Vec<u8> {
    let mut body = body_with_header(&serde_json::to_vec(&header).unwrap());
    body.extend_from_slice(payload);
    body
  }

  pub fn hello_reply(protocol: u64, methods: &[&str]) -> Vec<u8> {
    reply_body(
      json!({
        "ok": true,
        "result": {
          "protocol": protocol,
          "tool": "niho-develop-render 0.26.0",
          "crateVersion": "0.26.0",
          "engine": "niho-14",
          "threads": 8,
          "methods": methods,
        },
        "blobs": [],
      }),
      &[],
    )
  }

  /// 試験の serve が知っている口。
  pub const METHODS: [&str; 5] = ["render", "slow", "crash", "Developer.render", "releaseClient"];

  /// hello に答え、`slow` には答えず、`crash` で落ち、ほかは `<method>:<本文>` を返す。
  pub fn echo() -> Script {
    Box::new(|id, method, body| match method {
      HELLO => Some(vec![(id, hello_reply(PROTOCOL, &METHODS))]),
      "slow" => Some(Vec::new()),
      "crash" => None,
      _ => Some(vec![(id, [method.as_bytes(), b":", body].concat())]),
    })
  }

  fn read_request(stream: &mut UnixStream) -> io::Result<(u32, String, Vec<u8>)> {
    let id = read_u32(stream)?;
    let mut method = vec![0u8; read_u32(stream)? as usize];
    stream.read_exact(&mut method)?;
    let mut body = vec![0u8; read_u32(stream)? as usize];
    stream.read_exact(&mut body)?;
    Ok((id, String::from_utf8(method).unwrap(), body))
  }

  fn serve(mut stream: UnixStream, mut script: Script) {
    while let Ok((id, method, body)) = read_request(&mut stream) {
      let Some(replies) = script(id, &method, &body) else {
        let _ = stream.shutdown(std::net::Shutdown::Both);
        return;
      };
      for (id, body) in replies {
        let mut frame = Vec::new();
        frame.extend_from_slice(&id.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        if stream.write_all(&frame).is_err() {
          return;
        }
      }
    }
  }

  struct FakeProcess {
    stream: UnixStream,
    kills: Arc<AtomicUsize>,
  }

  impl Process for FakeProcess {
    fn terminate(&mut self) -> Value {
      self.kills.fetch_add(1, Ordering::SeqCst);
      let _ = self.stream.shutdown(std::net::Shutdown::Both);
      Value::Null
    }
  }

  pub struct Fake {
    pub engine: DevelopEngine,
    pub spawns: Arc<AtomicUsize>,
    pub kills: Arc<AtomicUsize>,
    pub events: Events,
    pub now: Arc<Mutex<Instant>>,
  }

  impl Fake {
    /// `scripts(n)` が n 回目（0 から）の起動の serve の振る舞い。
    pub fn new(scripts: impl Fn(usize) -> Script + Send + Sync + 'static, timeouts: Timeouts) -> Self {
      let spawns = Arc::new(AtomicUsize::new(0));
      let kills = Arc::new(AtomicUsize::new(0));
      let events: Events = Arc::default();
      let now = Arc::new(Mutex::new(Instant::now()));
      let spawn: Spawn = {
        let spawns = spawns.clone();
        let kills = kills.clone();
        Arc::new(move || -> Result<Connection, Unavailable> {
          let index = spawns.fetch_add(1, Ordering::SeqCst);
          let (ours, theirs) = UnixStream::pair().map_err(|_| SPAWN_FAILED)?;
          let script = scripts(index);
          std::thread::spawn(move || serve(theirs, script));
          Ok(Connection {
            reader: Box::new(ours.try_clone().map_err(|_| SPAWN_FAILED)?),
            writer: Box::new(ours.try_clone().map_err(|_| SPAWN_FAILED)?),
            process: Box::new(FakeProcess {
              stream: ours,
              kills: kills.clone(),
            }),
          })
        })
      };
      let clock: Clock = {
        let now = now.clone();
        Arc::new(move || *lock(&now))
      };
      let log: LogFn = {
        let events = events.clone();
        Arc::new(move |kind, payload| lock(&events).push((kind.to_string(), payload)))
      };
      Self {
        engine: DevelopEngine::new(spawn, clock, log, timeouts),
        spawns,
        kills,
        events,
        now,
      }
    }

    pub fn echo() -> Self {
      Self::new(|_| echo(), quick())
    }

    pub fn spawns(&self) -> usize {
      self.spawns.load(Ordering::SeqCst)
    }

    pub fn kills(&self) -> usize {
      self.kills.load(Ordering::SeqCst)
    }

    pub fn events(&self, kind: &str) -> Vec<Value> {
      lock(&self.events)
        .iter()
        .filter(|(event, _)| event == kind)
        .map(|(_, payload)| payload.clone())
        .collect()
    }

    pub fn advance(&self, by: Duration) {
      *lock(&self.now) += by;
    }
  }

  impl Drop for Fake {
    fn drop(&mut self) {
      self.engine.stop();
    }
  }

  /// 試験の待ち（落ちる試験以外は十分に長く）。
  pub fn quick() -> Timeouts {
    Timeouts {
      hello: Duration::from_secs(5),
      request: Duration::from_secs(5),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::test_support::*;
  use super::*;
  use std::sync::mpsc::channel;
  use std::sync::Condvar;

  fn answered(fake: &Fake, method: &str, body: &[u8]) -> Vec<u8> {
    fake.engine.call(method, body).expect("answered")
  }

  #[test]
  fn the_envelopes_carry_id_method_and_body_in_little_endian() {
    let mut bytes: Vec<u8> = Vec::new();
    write_request(&mut bytes, 7, "Developer.render", b"abc").unwrap();
    let mut expected = vec![7, 0, 0, 0, 16, 0, 0, 0];
    expected.extend_from_slice(b"Developer.render");
    expected.extend_from_slice(&[3, 0, 0, 0]);
    expected.extend_from_slice(b"abc");
    assert_eq!(bytes, expected);
    assert!(
      write_request(&mut Vec::<u8>::new(), 1, &"a".repeat(65), b"x").is_err(),
      "method は 64 bytes まで"
    );
    assert!(write_request(&mut Vec::<u8>::new(), 1, "a/b", b"x").is_err());

    let reply = [9u8, 0, 0, 0, 2, 0, 0, 0, b'o', b'k'];
    assert_eq!(read_reply(&mut &reply[..]).unwrap(), (9, b"ok".to_vec()));
    assert!(read_reply(&mut &reply[..9]).is_err(), "読み切れない本文");
    assert!(read_reply(&mut &reply[..6]).is_err(), "読み切れない長さ");
    let huge = [1u8, 0, 0, 0, 0xff, 0xff, 0xff, 0xff];
    assert_eq!(
      read_reply(&mut &huge[..]).unwrap_err().kind(),
      io::ErrorKind::InvalidData,
      "上限を超える長さは領域を取らずに落とす"
    );
    assert_eq!(&hello_request_body()[4..], br#"{"args":[],"blobs":[]}"#);
    assert_eq!(hello_request_body()[..4], 22u32.to_le_bytes());
  }

  #[test]
  fn method_names_are_letters_and_dots_up_to_64_bytes() {
    for name in ["render", "Developer.render", "releaseClient", &"a".repeat(64)] {
      assert!(is_method_name(name), "{name}");
    }
    for name in ["", "a/b", "render2", "a b", "a%2Fb", "ré", &"a".repeat(65)] {
      assert!(!is_method_name(name), "{name}");
    }
  }

  #[test]
  fn hello_must_be_ok_protocol_one_with_method_names() {
    let hello = parse_hello(&hello_reply(1, &["render", "Developer.render"])).unwrap();
    assert_eq!(hello.crate_version, "0.26.0");
    assert_eq!(hello.engine, "niho-14");
    assert_eq!(hello.threads, 8);
    assert_eq!(hello.methods, ["render", "Developer.render"]);
    assert_eq!(parse_hello(&hello_reply(2, &["render"])), Err(PROTOCOL_MISMATCH));
    assert_eq!(parse_hello(&hello_reply(1, &[])), Err(HELLO_INVALID));
    assert_eq!(parse_hello(&hello_reply(1, &["a/b"])), Err(HELLO_INVALID));
    assert_eq!(
      parse_hello(&reply_body(json!({ "ok": false, "error": "x" }), &[])),
      Err(HELLO_INVALID)
    );
    assert_eq!(
      parse_hello(&reply_body(json!({ "ok": true, "result": { "protocol": 1 } }), &[])),
      Err(HELLO_INVALID)
    );
    assert_eq!(parse_hello(&[1, 0]), Err(HELLO_INVALID));
    assert_eq!(parse_hello(&[200, 0, 0, 0, b'{']), Err(HELLO_INVALID));
  }

  #[test]
  fn the_first_call_starts_the_sidecar_with_hello_and_calls_are_forwarded() {
    let seen: Arc<Mutex<Vec<(u32, String)>>> = Arc::default();
    let fake = {
      let seen = seen.clone();
      Fake::new(
        move |_| {
          let seen = seen.clone();
          let mut inner = echo();
          Box::new(move |id, method, body| {
            lock(&seen).push((id, method.to_string()));
            inner(id, method, body)
          })
        },
        quick(),
      )
    };
    assert_eq!(fake.spawns(), 0, "起動時には立てない");
    assert_eq!(answered(&fake, "render", b"abc"), b"render:abc");
    assert_eq!(answered(&fake, "Developer.render", b"x"), b"Developer.render:x");
    assert_eq!(fake.engine.call("exportTiff", b"x"), Err(CallError::UnknownMethod));
    let hello = answered(&fake, HELLO, &hello_request_body());
    assert_eq!(
      parse_hello(&hello).unwrap().engine,
      "niho-14",
      "画面の glue の hello も通す"
    );
    assert_eq!(fake.spawns(), 1);
    assert_eq!(
      *lock(&seen),
      [
        (0, "hello".to_string()),
        (1, "render".to_string()),
        (2, "Developer.render".to_string()),
        (3, "hello".to_string()),
      ],
      "最初に id 0 の hello。知らない method は送らない"
    );
    assert_eq!(
      fake.events("camera.develop_serve_started"),
      [json!({ "restart": false, "restartsInWindow": 0 })]
    );
    assert_eq!(
      fake.events("camera.develop_serve_ready"),
      [json!({
        "tool": "niho-develop-render 0.26.0",
        "crateVersion": "0.26.0",
        "engine": "niho-14",
        "threads": 8,
        "methods": METHODS.len(),
      })]
    );
  }

  #[test]
  fn replies_in_another_order_reach_their_callers_by_id() {
    // 最初の render は持っておき、2 つ目が来たら 2 つ目・1 つ目の順に答える
    let fake = Fake::new(
      |_| {
        let mut held: Option<(u32, Vec<u8>)> = None;
        let mut inner = echo();
        Box::new(move |id, method, body| {
          if method != "render" {
            return inner(id, method, body);
          }
          let reply = (id, [b"render:".as_slice(), body].concat());
          match held.take() {
            None => {
              held = Some(reply);
              Some(Vec::new())
            }
            Some(first) => Some(vec![reply, first]),
          }
        })
      },
      quick(),
    );
    std::thread::scope(|scope| {
      let a = scope.spawn(|| fake.engine.call("render", b"a"));
      let b = scope.spawn(|| fake.engine.call("render", b"b"));
      assert_eq!(a.join().unwrap().unwrap(), b"render:a");
      assert_eq!(b.join().unwrap().unwrap(), b"render:b");
    });
    assert_eq!(fake.spawns(), 1);
  }

  #[test]
  fn a_crash_fails_every_waiter_and_the_next_call_starts_again() {
    let (seen_sender, seen) = channel::<String>();
    let seen_sender = Mutex::new(seen_sender);
    let fake = Fake::new(
      move |_| {
        let seen_sender = lock(&seen_sender).clone();
        let mut inner = echo();
        Box::new(move |id, method, body| {
          let _ = seen_sender.send(method.to_string());
          inner(id, method, body)
        })
      },
      quick(),
    );
    std::thread::scope(|scope| {
      let waiting = scope.spawn(|| fake.engine.call("slow", b"x"));
      while seen.recv().unwrap() != "slow" {}
      assert_eq!(fake.engine.call("crash", b"x"), Err(CallError::Unavailable(EXITED)));
      assert_eq!(
        waiting.join().unwrap(),
        Err(CallError::Unavailable(EXITED)),
        "待っていた要求も失敗"
      );
    });
    assert_eq!(fake.kills(), 1, "落ちた子も片付ける");
    assert_eq!(
      fake.events("camera.develop_serve_exited"),
      [json!({ "reason": "exited", "pending": 2, "status": null })]
    );
    assert_eq!(answered(&fake, "render", b"again"), b"render:again");
    assert_eq!(fake.spawns(), 2);
    assert_eq!(
      fake.events("camera.develop_serve_started")[1],
      json!({ "restart": true, "restartsInWindow": 1 })
    );
  }

  #[test]
  fn an_old_worker_cannot_use_a_recycled_handle_after_restart() {
    let fake = Fake::echo();
    let old = "old-client";
    let fresh = "new-client";
    assert_eq!(
      fake.engine.call_for_client(old, "render", b"old"),
      Err(CallError::Unavailable(STALE_CLIENT)),
      "a Worker must say hello before using handles"
    );
    fake.engine.call_for_client(old, HELLO, &hello_request_body()).unwrap();
    assert_eq!(
      fake.engine.call_for_client(old, "render", b"old").unwrap(),
      b"render:old"
    );
    assert_eq!(
      fake.engine.call_for_client(old, "crash", b"x"),
      Err(CallError::Unavailable(EXITED))
    );
    fake
      .engine
      .call_for_client(fresh, HELLO, &hello_request_body())
      .unwrap();
    assert_eq!(fake.spawns(), 2);
    assert_eq!(
      fake.engine.call_for_client(old, "render", b"stale"),
      Err(CallError::Unavailable(STALE_CLIENT)),
      "the old numeric handle must not reach the new registry"
    );
    assert_eq!(
      fake.engine.call_for_client(fresh, "render", b"new").unwrap(),
      b"render:new"
    );
  }

  #[test]
  fn deadline_stops_a_child_even_when_writing_to_stdin_is_blocked() {
    struct BlockedWrite(Arc<(Mutex<bool>, Condvar)>);
    impl Write for BlockedWrite {
      fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        let (closed, changed) = &*self.0;
        let mut closed = lock(closed);
        while !*closed {
          closed = changed.wait(closed).unwrap_or_else(PoisonError::into_inner);
        }
        Err(io::ErrorKind::BrokenPipe.into())
      }
      fn flush(&mut self) -> io::Result<()> {
        Ok(())
      }
    }
    struct BlockedProcess(Arc<(Mutex<bool>, Condvar)>);
    impl Process for BlockedProcess {
      fn terminate(&mut self) -> Value {
        let (closed, changed) = &*self.0;
        *lock(closed) = true;
        changed.notify_all();
        Value::Null
      }
    }
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let session = Session::new(
      Box::new(BlockedWrite(gate.clone())),
      Box::new(BlockedProcess(gate)),
      Arc::new(|_, _| {}),
      1,
    );
    let started = Instant::now();
    assert_eq!(
      session.request(1, "render", b"photo", Duration::from_millis(100)),
      Err(TIMED_OUT)
    );
    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn restarts_are_limited_to_three_a_minute() {
    let fake = Fake::echo();
    // 最初の起動は数えない
    assert_eq!(fake.engine.call("crash", b""), Err(CallError::Unavailable(EXITED)));
    for restart in 1..=3 {
      assert_eq!(
        fake.engine.call("crash", b""),
        Err(CallError::Unavailable(EXITED)),
        "{restart}"
      );
    }
    assert_eq!(fake.spawns(), 4);
    for _ in 0..2 {
      assert_eq!(
        fake.engine.call("render", b""),
        Err(CallError::Unavailable(RESTART_LIMIT))
      );
    }
    assert_eq!(fake.spawns(), 4, "上限の間は起動しない");
    assert_eq!(
      fake.events("camera.develop_serve_unavailable"),
      [json!({ "reason": RESTART_LIMIT.0 })],
      "上限はログに 1 回"
    );

    fake.advance(Duration::from_secs(59));
    assert_eq!(
      fake.engine.call("render", b""),
      Err(CallError::Unavailable(RESTART_LIMIT))
    );
    fake.advance(Duration::from_secs(1));
    assert_eq!(answered(&fake, "render", b"1"), b"render:1", "1 分たてば起動し直せる");
    assert_eq!(fake.spawns(), 5);
  }

  #[test]
  fn a_page_load_gives_a_fresh_start_even_at_the_restart_limit() {
    let fake = Fake::echo();
    for _ in 0..4 {
      let _ = fake.engine.call("crash", b"");
    }
    assert_eq!(
      fake.engine.call("render", b""),
      Err(CallError::Unavailable(RESTART_LIMIT))
    );
    fake.engine.stop();
    assert_eq!(answered(&fake, "render", b"fresh"), b"render:fresh");
    assert_eq!(fake.spawns(), 5);
  }

  #[test]
  fn a_request_past_its_deadline_stops_the_sidecar() {
    let fake = Fake::new(
      |_| echo(),
      Timeouts {
        hello: Duration::from_secs(5),
        request: Duration::from_millis(200),
      },
    );
    assert_eq!(answered(&fake, "render", b"1"), b"render:1");
    assert_eq!(fake.engine.call("slow", b""), Err(CallError::Unavailable(TIMED_OUT)));
    assert_eq!(fake.kills(), 1);
    assert_eq!(
      fake.events("camera.develop_serve_exited"),
      [json!({ "reason": "timedOut", "pending": 1, "status": null })]
    );
    assert_eq!(answered(&fake, "render", b"2"), b"render:2");
    assert_eq!(fake.spawns(), 2);
  }

  #[test]
  fn hello_of_another_protocol_or_no_hello_is_unavailable() {
    let other = Fake::new(
      |_| Box::new(|id, _, _| Some(vec![(id, hello_reply(2, &METHODS))])),
      quick(),
    );
    assert_eq!(
      other.engine.call("render", b""),
      Err(CallError::Unavailable(PROTOCOL_MISMATCH))
    );
    assert_eq!(other.kills(), 1, "違う版の子は止める");
    assert_eq!(
      other.events("camera.develop_serve_unavailable"),
      [json!({ "reason": PROTOCOL_MISMATCH.0 })]
    );

    let silent = Fake::new(
      |_| Box::new(|_, _, _| Some(Vec::new())),
      Timeouts {
        hello: Duration::from_millis(200),
        request: Duration::from_secs(5),
      },
    );
    assert_eq!(
      silent.engine.call("render", b""),
      Err(CallError::Unavailable(HELLO_TIMED_OUT))
    );
    assert_eq!(silent.kills(), 1);
  }

  #[test]
  fn a_sidecar_that_cannot_start_is_unavailable() {
    let events: Events = Arc::default();
    let log: LogFn = {
      let events = events.clone();
      Arc::new(move |kind, payload| lock(&events).push((kind.to_string(), payload)))
    };
    let engine = DevelopEngine::new(
      Arc::new(|| -> Result<Connection, Unavailable> { Err(NOT_BUNDLED) }),
      Arc::new(Instant::now),
      log,
      quick(),
    );
    assert_eq!(engine.call("render", b""), Err(CallError::Unavailable(NOT_BUNDLED)));
    assert_eq!(
      *lock(&events),
      [(
        "camera.develop_serve_unavailable".to_string(),
        json!({ "reason": NOT_BUNDLED.0 })
      )]
    );
  }

  #[test]
  fn stop_releases_the_sidecar_and_fails_the_waiters() {
    let (seen_sender, seen) = channel::<String>();
    let seen_sender = Mutex::new(seen_sender);
    let fake = Fake::new(
      move |_| {
        let seen_sender = lock(&seen_sender).clone();
        let mut inner = echo();
        Box::new(move |id, method, body| {
          let _ = seen_sender.send(method.to_string());
          inner(id, method, body)
        })
      },
      quick(),
    );
    fake.engine.stop();
    assert_eq!(fake.kills(), 0, "起動していなければ何もしない");
    std::thread::scope(|scope| {
      let waiting = scope.spawn(|| fake.engine.call("slow", b""));
      while seen.recv().unwrap() != "slow" {}
      fake.engine.stop();
      assert_eq!(waiting.join().unwrap(), Err(CallError::Unavailable(STOPPED)));
    });
    assert_eq!(fake.kills(), 1);
    assert_eq!(
      fake.events("camera.develop_serve_exited"),
      [json!({ "reason": "stopped", "pending": 1, "status": null })]
    );
    assert_eq!(answered(&fake, "render", b"next"), b"render:next");
    assert_eq!(fake.spawns(), 2);
    assert_eq!(
      fake.events("camera.develop_serve_started"),
      [
        json!({ "restart": false, "restartsInWindow": 0 }),
        json!({ "restart": false, "restartsInWindow": 0 }),
      ],
      "止めた後の起動は起動し直しに数えない"
    );
  }
}
