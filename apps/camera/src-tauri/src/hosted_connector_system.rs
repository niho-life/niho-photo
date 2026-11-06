//! 常設 Mac の接続用ソフト（Epic #240 / B03 #244）の macOS の口。どれも公開 API で、外へ通信しない。
//!
//! - 休止の抑止: IOKit の `IOPMAssertionCreateWithName`（`PreventUserIdleSystemSleep`）。job・同期・走査の間だけ持ち、
//!   終われば外す。process が終われば OS が外す。画面の消灯は止めない。
//! - 休止・復帰の検知: IOKit の `IORegisterForSystemPower`。休止の前に接続用ソフトへ知らせ、NIHO へ `sleeping` を送る間
//!   （最長 `hosted_connector::SLEEP_GRACE`）待ってから休止を許す。復帰したら知らせる。
//! - 常駐: ServiceManagement の `SMAppService.agentServiceWithPlistName:`（macOS 13 以降）。.app に同梱した LaunchAgent の
//!   plist（`launchd/life.niho.camera.hosted-connector.plist`）を登録・解除する。初回は「ログイン項目」で利用者の許可が要る。
//! - 端末資格の保管: Keychain の generic password（Security.framework。`niho_desktop_account` と同じ crate）。

use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};

use objc2::msg_send;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2_foundation::NSString;

// ---------------------------------------------------------------------------
// 休止の抑止

type CFStringRef = *const c_void;

#[link(name = "IOKit", kind = "framework")]
extern "C" {
  fn IOPMAssertionCreateWithName(assertion_type: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
  fn IOPMAssertionRelease(id: u32) -> i32;
}

/// `kIOPMAssertionLevelOn`
const ASSERTION_LEVEL_ON: u32 = 255;
/// `kIOPMAssertionTypePreventUserIdleSystemSleep`（操作が無くても休止しない。画面は消える）
const PREVENT_IDLE_SLEEP: &str = "PreventUserIdleSystemSleep";

/// 休止を抑える。抑えられなければ None（job は続ける。休止したら復帰後に続きから）。
pub fn hold_awake(reason: &str) -> Option<u32> {
  let kind = NSString::from_str(PREVENT_IDLE_SLEEP);
  let name = NSString::from_str(reason);
  let mut id = 0u32;
  // SAFETY: NSString は CFString と toll-free bridge で、どちらも呼び出しの間生きている。id は書き込み先。
  let status = unsafe {
    IOPMAssertionCreateWithName(
      Retained::as_ptr(&kind).cast(),
      ASSERTION_LEVEL_ON,
      Retained::as_ptr(&name).cast(),
      &mut id,
    )
  };
  (status == 0).then_some(id)
}

/// `hold_awake` の抑止を外す（持ち主の電源設定に戻る）。
pub fn release_awake(id: u32) {
  // SAFETY: hold_awake が返した assertion の ID。外すのは一度だけ（呼び出し側が持つ表から取り除いてから呼ぶ）。
  unsafe {
    IOPMAssertionRelease(id);
  }
}

// ---------------------------------------------------------------------------
// 休止・復帰の検知

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerEvent {
  WillSleep,
  DidWake,
}

type IoObject = u32;
type IoConnect = u32;
type NotificationPortRef = *mut c_void;
type RunLoopRef = *mut c_void;
type RunLoopSourceRef = *mut c_void;
type InterestCallback = extern "C" fn(refcon: *mut c_void, service: IoObject, message_type: u32, argument: *mut c_void);

#[link(name = "IOKit", kind = "framework")]
extern "C" {
  fn IORegisterForSystemPower(
    refcon: *mut c_void,
    port: *mut NotificationPortRef,
    callback: InterestCallback,
    notifier: *mut IoObject,
  ) -> IoConnect;
  fn IONotificationPortGetRunLoopSource(port: NotificationPortRef) -> RunLoopSourceRef;
  fn IOAllowPowerChange(kernel_port: IoConnect, notification_id: isize) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
#[allow(non_upper_case_globals)]
extern "C" {
  fn CFRunLoopGetCurrent() -> RunLoopRef;
  fn CFRunLoopAddSource(run_loop: RunLoopRef, source: RunLoopSourceRef, mode: CFStringRef);
  fn CFRunLoopRun();
  static kCFRunLoopDefaultMode: CFStringRef;
}

/// `kIOMessageCanSystemSleep`（操作が無いので休止してよいか）
const MESSAGE_CAN_SYSTEM_SLEEP: u32 = 0xe000_0270;
/// `kIOMessageSystemWillSleep`（休止する。許すまで最長 30 秒待つ）
const MESSAGE_SYSTEM_WILL_SLEEP: u32 = 0xe000_0280;
/// `kIOMessageSystemHasPoweredOn`（復帰した）
const MESSAGE_SYSTEM_HAS_POWERED_ON: u32 = 0xe000_0300;

struct PowerContext {
  root_port: AtomicU32,
  on_event: Box<dyn Fn(PowerEvent) + Send + Sync>,
}

extern "C" fn on_system_power(refcon: *mut c_void, _service: IoObject, message_type: u32, argument: *mut c_void) {
  // SAFETY: refcon は watch_system_power が leak した PowerContext（process の間生きる）。
  let context = unsafe { &*(refcon as *const PowerContext) };
  let allow = || {
    // SAFETY: 休止の問い合わせ・通知に、受け取った ID で一度だけ答える。
    unsafe {
      IOAllowPowerChange(context.root_port.load(Ordering::Acquire), argument as isize);
    }
  };
  match message_type {
    // 抑止中（job の間）は OS がそもそも問い合わせない。ここへ来たら許す
    MESSAGE_CAN_SYSTEM_SLEEP => allow(),
    MESSAGE_SYSTEM_WILL_SLEEP => {
      // 接続用ソフトが NIHO へ sleeping を送り終えるまで（最長 SLEEP_GRACE）待ってから許す
      (context.on_event)(PowerEvent::WillSleep);
      allow();
    }
    MESSAGE_SYSTEM_HAS_POWERED_ON => (context.on_event)(PowerEvent::DidWake),
    _ => {}
  }
}

/// 休止・復帰を専用の thread の run loop で受け、`on_event` を呼ぶ。`WillSleep` は `on_event` が戻るまで休止を待たせる。
/// 登録できなければ false（休止の前の知らせが無いだけで、復帰後の差分の取り込みは heartbeat で続く）。
pub fn watch_system_power(on_event: Box<dyn Fn(PowerEvent) + Send + Sync>) -> bool {
  let (ready_tx, ready_rx) = std::sync::mpsc::channel();
  let spawned = std::thread::Builder::new()
    .name("hosted-connector-power".into())
    .spawn(move || {
      let context: &'static PowerContext = Box::leak(Box::new(PowerContext {
        root_port: AtomicU32::new(0),
        on_event,
      }));
      let mut port: NotificationPortRef = std::ptr::null_mut();
      let mut notifier: IoObject = 0;
      // SAFETY: refcon は process の間生きる context。port・notifier は書き込み先。
      let root_port = unsafe {
        IORegisterForSystemPower(
          (context as *const PowerContext).cast_mut().cast(),
          &mut port,
          on_system_power,
          &mut notifier,
        )
      };
      if root_port == 0 || port.is_null() {
        let _ = ready_tx.send(false);
        return;
      }
      context.root_port.store(root_port, Ordering::Release);
      // SAFETY: port は IORegisterForSystemPower が返した notification port。この thread の run loop に足して回し続ける。
      unsafe {
        let source = IONotificationPortGetRunLoopSource(port);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
      }
      let _ = ready_tx.send(true);
      // SAFETY: この thread の run loop を回す（process の間戻らない）。
      unsafe { CFRunLoopRun() };
    });
  spawned.is_ok() && ready_rx.recv().unwrap_or(false)
}

// ---------------------------------------------------------------------------
// 常駐（launchd の LaunchAgent）

/// .app の `Contents/Library/LaunchAgents/` に同梱する plist の名前（tauri.conf.json の `bundle.macOS.files`）。
pub const AGENT_PLIST: &str = "life.niho.camera.hosted-connector.plist";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
  NotRegistered,
  Enabled,
  /// 「システム設定 > 一般 > ログイン項目」で利用者の許可を待っている
  RequiresApproval,
  /// plist が .app に無い（開発の build・bundle の外の実行）
  NotFound,
}

// SMAppService の class を読み込む
#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

fn agent_service() -> Option<Retained<AnyObject>> {
  let class = AnyClass::get(c"SMAppService")?;
  let name = NSString::from_str(AGENT_PLIST);
  // SAFETY: SMAppService の公開 class method（macOS 13 以降。最低は 14）。引数は NSString。
  unsafe { msg_send![class, agentServiceWithPlistName: &*name] }
}

fn status_of(service: &AnyObject) -> AgentStatus {
  // SAFETY: SMAppService の公開 property（SMAppServiceStatus = NSInteger）。
  let status: isize = unsafe { msg_send![service, status] };
  match status {
    1 => AgentStatus::Enabled,
    2 => AgentStatus::RequiresApproval,
    3 => AgentStatus::NotFound,
    _ => AgentStatus::NotRegistered,
  }
}

/// 今の登録の状態。
pub fn agent_status() -> AgentStatus {
  autoreleasepool(|_| agent_service().map_or(AgentStatus::NotFound, |service| status_of(&service)))
}

/// 登録する（ログイン時に起動し、落ちたら launchd が起動し直す）。許可待ちなら「ログイン項目」を開く。
pub fn agent_register() -> AgentStatus {
  autoreleasepool(|_| {
    let Some(service) = agent_service() else {
      return AgentStatus::NotFound;
    };
    if status_of(&service) != AgentStatus::Enabled {
      // SAFETY: SMAppService の公開 method。失敗は NSError で返り、状態を読み直す。
      let _: Result<(), Retained<NSObject>> = unsafe { msg_send![&*service, registerAndReturnError: _] };
    }
    let status = status_of(&service);
    if status == AgentStatus::RequiresApproval {
      open_login_items();
    }
    status
  })
}

/// 登録を外す（次のログインから起動しない。動いている process は止めない）。
pub fn agent_unregister() -> AgentStatus {
  autoreleasepool(|_| {
    let Some(service) = agent_service() else {
      return AgentStatus::NotFound;
    };
    if status_of(&service) != AgentStatus::NotRegistered {
      // SAFETY: SMAppService の公開 method。失敗は NSError で返り、状態を読み直す。
      let _: Result<(), Retained<NSObject>> = unsafe { msg_send![&*service, unregisterAndReturnError: _] };
    }
    status_of(&service)
  })
}

fn open_login_items() {
  if let Some(class) = AnyClass::get(c"SMAppService") {
    // SAFETY: SMAppService の公開 class method（「ログイン項目」を開く）。
    let _: () = unsafe { msg_send![class, openSystemSettingsLoginItems] };
  }
}

// ---------------------------------------------------------------------------
// 端末資格の保管（Keychain）

const VAULT_SERVICE: &str = "life.niho.camera.hosted-connector";
const VAULT_ACCOUNT: &str = "vault-v1";
/// `errSecItemNotFound`
const ITEM_NOT_FOUND: i32 = -25300;

/// Keychain を読めない・書けない（ロック中・拒否）。中身は返さない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultError;

/// 接続用ソフトの vault（端末資格・登録中と回転中の秘密・localKey の salt）を 1 つの Keychain 項目として読む。
pub fn vault_read() -> Result<Option<Vec<u8>>, VaultError> {
  use security_framework::passwords::{generic_password, PasswordOptions};
  match generic_password(PasswordOptions::new_generic_password(VAULT_SERVICE, VAULT_ACCOUNT)) {
    Ok(bytes) => Ok(Some(bytes)),
    Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
    Err(_) => Err(VaultError),
  }
}

/// vault 全体を置き換える（Keychain の 1 項目の更新は原子的）。
pub fn vault_write(bytes: &[u8]) -> Result<(), VaultError> {
  security_framework::passwords::set_generic_password(VAULT_SERVICE, VAULT_ACCOUNT, bytes).map_err(|_| VaultError)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_idle_sleep_assertion_can_be_held_and_released() {
    let id = hold_awake("NIHO photo test").expect("IOPM assertion");
    release_awake(id);
  }

  #[test]
  fn the_agent_plist_is_not_found_outside_the_app_bundle() {
    // 試験の実行ファイルは .app の外なので、同梱の plist は使えない（登録もしない）
    assert!(matches!(
      agent_status(),
      AgentStatus::NotFound | AgentStatus::NotRegistered
    ));
    assert_eq!(
      serde_json::to_value(AgentStatus::RequiresApproval).unwrap(),
      "requiresApproval"
    );
  }
}
