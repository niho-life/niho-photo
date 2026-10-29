//! `niho-develop-render serve` (#152): the develop engine's calls for the
//! Mac app's photo editor, one long-lived process answering the requests
//! the app (Tauri) passes on from its native glue over stdin / stdout.
//! Every method is a wasm export by its JS name and runs the same
//! `niho_develop::api` call as the wasm, so the pixels, bytes, JSON and
//! error messages are the wasm's ([`methods::METHODS`]).
//!
//! stdin carries requests and stdout responses, each a frame
//! (`u32` = little endian):
//!
//! ```text
//! request   u32 id · u32 M · M bytes method (ASCII) · u32 B · B bytes body
//! response  u32 id · u32 B · B bytes body
//! body      u32 H · H bytes header (a JSON object) · payload (the blobs)
//! ```
//!
//! A request header is `{"args":[...],"blobs":[n0,...],"handle"?,"client"?}`
//! (a binary argument is `{"blob":i}`); a response header is
//! `{"ok":true,"result":...,"blobs":[...]}` or
//! `{"ok":false,"error":"...","code"?:"..."}` ([`request`]). Requests run on
//! their own threads, at most [`MAX_CONCURRENT_REQUESTS`] at a time (the
//! next frame is read when one ends); the responses may come in another
//! order than the requests, each written whole. `serve` ends with exit 0
//! when stdin ends (after the requests being answered) and with exit 1 on a
//! broken frame (cut short, a method over [`MAX_METHOD_BYTES`] or a body
//! over [`MAX_BODY_BYTES`]); any other bad request gets an error response.
//! stdout carries frames only: a panic is a line on stderr (and, where the
//! build unwinds, an `internal` response that lets go of its Developer).

mod methods;
mod request;

use std::any::Any;
use std::io::{self, BufWriter, Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

pub use methods::METHODS;

/// `hello`'s `protocol`: the frames and bodies above.
pub const PROTOCOL: u32 = 1;
/// The longest method name in bytes.
pub const MAX_METHOD_BYTES: u32 = 64;
/// The largest request body in bytes (1 GiB).
pub const MAX_BODY_BYTES: u32 = 1 << 30;
/// Requests answered at the same time.
pub const MAX_CONCURRENT_REQUESTS: usize = 8;
/// Developers alive at the same time (`tooManyDevelopers` past it).
pub const MAX_DEVELOPERS: usize = 64;
/// Exit code when stdin ends.
pub const EXIT_END: i32 = 0;
/// Exit code of a broken frame (or of stdout that cannot be written).
pub const EXIT_BROKEN: i32 = 1;

/// A request thread's stack (a render runs on it).
const STACK_BYTES: usize = 8 << 20;

/// Serves stdin / stdout until stdin ends; returns the exit code.
pub fn run_stdio() -> i32 {
    install_panic_hook();
    let stdin = io::stdin();
    serve(
        stdin.lock(),
        BufWriter::with_capacity(1 << 20, io::stdout()),
    )
}

/// Serves `input` / `output` until `input` ends (exit 0) or a frame is
/// broken (exit 1); returns after the requests being answered.
pub fn serve<R: Read, W: Write + Send + 'static>(mut input: R, output: W) -> i32 {
    let output = Arc::new(Mutex::new(output));
    let state = Arc::new(methods::State::default());
    let slots = Arc::new(Slots::default());
    let code = loop {
        let slot = Slots::acquire(&slots);
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => break EXIT_END,
            Err(message) => {
                eprintln!("niho-develop-render serve: {message}");
                break EXIT_BROKEN;
            }
        };
        let id = frame.id;
        let worker_output = Arc::clone(&output);
        let worker_state = Arc::clone(&state);
        let spawned = thread::Builder::new()
            .name(format!("serve-{id}"))
            .stack_size(STACK_BYTES)
            .spawn(move || {
                let _slot = slot;
                let reply = methods::respond(&worker_state, &frame.method, &frame.body);
                drop(frame);
                write_response(&worker_output, id, &reply);
            });
        if let Err(e) = spawned {
            let reply =
                request::Fail::coded(request::INTERNAL, format!("cannot start a thread: {e}"));
            write_response(&output, id, &reply.into());
        }
    };
    slots.wait_idle();
    code
}

/// One request frame.
struct Frame {
    id: u32,
    method: String,
    body: Vec<u8>,
}

/// Reads one frame: `None` when the input ends before it, an error when it
/// is broken.
fn read_frame(input: &mut impl Read) -> Result<Option<Frame>, String> {
    let mut first = [0u8; 4];
    match read_full(input, &mut first)? {
        0 => return Ok(None),
        4 => {}
        n => return Err(format!("the input ends {n} bytes into a request id")),
    }
    let id = u32::from_le_bytes(first);
    let method_length = read_u32(input, "the method length")?;
    if method_length > MAX_METHOD_BYTES {
        return Err(format!(
            "request {id}: a method of {method_length} bytes (at most {MAX_METHOD_BYTES})"
        ));
    }
    let method = read_bytes(input, method_length, "the method")?;
    let body_length = read_u32(input, "the body length")?;
    if body_length > MAX_BODY_BYTES {
        return Err(format!(
            "request {id}: a body of {body_length} bytes (at most {MAX_BODY_BYTES})"
        ));
    }
    let body = read_bytes(input, body_length, "the body")?;
    Ok(Some(Frame {
        id,
        method: String::from_utf8_lossy(&method).into_owned(),
        body,
    }))
}

/// Reads until `buf` is full or the input ends; the bytes read.
fn read_full(input: &mut impl Read, buf: &mut [u8]) -> Result<usize, String> {
    let mut filled = 0;
    while filled < buf.len() {
        match input.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(format!("cannot read the input: {e}")),
        }
    }
    Ok(filled)
}

fn read_u32(input: &mut impl Read, what: &str) -> Result<u32, String> {
    let mut bytes = [0u8; 4];
    if read_full(input, &mut bytes)? != 4 {
        return Err(format!("the input ends in {what}"));
    }
    Ok(u32::from_le_bytes(bytes))
}

fn read_bytes(input: &mut impl Read, length: u32, what: &str) -> Result<Vec<u8>, String> {
    let length = length as usize;
    // Grown as the bytes come (a frame cut short holds no 1 GiB buffer).
    let mut bytes = Vec::with_capacity(length.min(1 << 24));
    Read::take(&mut *input, length as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read the input: {e}"))?;
    if bytes.len() != length {
        return Err(format!(
            "the input ends in {what} ({} of {length} bytes)",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// Writes one response frame whole. stdout that cannot be written ends
/// `serve` (exit 1): nobody reads the responses any more.
fn write_response<W: Write>(output: &Mutex<W>, id: u32, reply: &request::Reply) {
    let header = reply.header_bytes();
    let length = 4 + header.len() + reply.blobs().iter().map(Vec::len).sum::<usize>();
    let Ok(length) = u32::try_from(length) else {
        let too_large = request::Fail::coded(
            request::INTERNAL,
            format!("the response of {length} bytes does not fit a frame"),
        );
        return write_response(output, id, &too_large.into());
    };
    let mut out = output
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Err(e) = write_frame(&mut *out, id, length, &header, reply.blobs()) {
        eprintln!("niho-develop-render serve: cannot write the output: {e}");
        std::process::exit(EXIT_BROKEN);
    }
}

fn write_frame(
    out: &mut impl Write,
    id: u32,
    length: u32,
    header: &[u8],
    blobs: &[Vec<u8>],
) -> io::Result<()> {
    out.write_all(&id.to_le_bytes())?;
    out.write_all(&length.to_le_bytes())?;
    out.write_all(&(header.len() as u32).to_le_bytes())?;
    out.write_all(header)?;
    for blob in blobs {
        out.write_all(blob)?;
    }
    out.flush()
}

/// The requests being answered (at most [`MAX_CONCURRENT_REQUESTS`]).
#[derive(Default)]
struct Slots {
    busy: Mutex<usize>,
    changed: Condvar,
}

/// One request's place; given back when dropped.
struct Slot(Arc<Slots>);

impl Slots {
    /// Waits for a free place.
    fn acquire(slots: &Arc<Slots>) -> Slot {
        let mut busy = slots
            .busy
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *busy >= MAX_CONCURRENT_REQUESTS {
            busy = slots
                .changed
                .wait(busy)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        *busy += 1;
        Slot(Arc::clone(slots))
    }

    /// Waits until no request is being answered.
    fn wait_idle(&self) {
        let mut busy = self
            .busy
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *busy > 0 {
            busy = self
                .changed
                .wait(busy)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut busy = self
            .0
            .busy
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *busy -= 1;
        self.0.changed.notify_all();
    }
}

/// The message of a panic's payload.
fn panic_text(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".into())
}

/// A panic is one line on stderr: stdout carries frames only. (`render`'s
/// hook, which prints the JSON line on stdout and exits, is replaced.)
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let current = thread::current();
        let text = format!("{}{location}", panic_text(info.payload())).replace(['\n', '\r'], " ");
        eprintln!(
            "niho-develop-render serve: panic in {}: {text}",
            current.name().unwrap_or("a thread")
        );
    }));
}

#[cfg(test)]
mod tests {
    use super::{read_frame, MAX_METHOD_BYTES};

    fn frame(id: u32, method: &[u8], body: &[u8]) -> Vec<u8> {
        let mut out = id.to_le_bytes().to_vec();
        out.extend_from_slice(&(method.len() as u32).to_le_bytes());
        out.extend_from_slice(method);
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn frames_are_read_whole_or_refused() {
        let mut bytes = frame(7, b"hello", b"");
        bytes.extend(frame(8, b"version", b"abc"));
        let mut input = &bytes[..];
        let first = read_frame(&mut input).unwrap().unwrap();
        assert_eq!((first.id, first.method.as_str()), (7, "hello"));
        assert!(first.body.is_empty());
        let second = read_frame(&mut input).unwrap().unwrap();
        assert_eq!((second.id, second.method.as_str()), (8, "version"));
        assert_eq!(second.body, b"abc");
        assert!(read_frame(&mut input).unwrap().is_none());

        let whole = frame(9, b"render", b"body");
        for cut in 1..whole.len() {
            assert!(read_frame(&mut &whole[..cut]).is_err(), "{cut}");
        }
        let long = b"a".repeat(MAX_METHOD_BYTES as usize + 1);
        assert!(read_frame(&mut &frame(1, &long, b"")[..]).is_err());
        let mut huge = 1u32.to_le_bytes().to_vec();
        huge.extend_from_slice(&1u32.to_le_bytes());
        huge.push(b'x');
        huge.extend_from_slice(&((1u32 << 30) + 1).to_le_bytes());
        assert!(read_frame(&mut &huge[..]).is_err());
    }
}
