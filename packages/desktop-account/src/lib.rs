//! Photo / DocsのNIHO app-connect public client。認証・認可の最終判断はサーバーが行う。
mod account;
mod connect;
mod photo_cloud;
mod photo_session;
mod secret;

pub use account::{Account, AccountPhase, AccountSnapshot};
pub use connect::{
  parse_callback, Browser, Callback, Cancel, ClientId, Config, ExternalBrowser, HttpTransport, Request, Response,
  Transport,
};
pub use photo_cloud::{
  photo_ephemeral_id, NativeCopyTarget, NativeProviderAck, NativeStartUpload, NativeUpload, NativeUploadState,
  NativeUploadTicket, PhotoContentMetadata, PhotoDownloadCancel, PhotoJsonResponse, PhotoOperation, PhotoRequest,
  PhotoScopeCapture,
};
pub use photo_session::{PhotoIdentity, PhotoIdentityTransport};
pub use secret::{CredentialStore, FileSecretStore, KeychainStore, Secret, SecretKind};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const SAFETY_CONTRACT_VERSION: u32 = 2;
pub const SAFETY_CONTRACT: &str = include_str!("../contract/native-account-v2.json");
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountError {
  NotConfigured,
  InvalidConfig,
  Busy,
  Cancelled,
  Expired,
  InvalidRedirect,
  InvalidState,
  InvalidResponse,
  Rejected,
  Network,
  Paused,
  AccountUnavailable,
  Browser,
  Storage,
  Internal,
}
impl fmt::Display for AccountError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{self:?}")
  }
}
impl std::error::Error for AccountError {}
#[cfg(test)]
mod tests;
