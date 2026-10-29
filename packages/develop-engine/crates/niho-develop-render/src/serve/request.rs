//! The body of a request and of a response (protocol 1):
//! `u32 LE header length · header (a UTF-8 JSON object) · payload` where
//! the payload is the binary arguments / results one after another, their
//! lengths in the header's `blobs`.

use serde_json::{json, Map, Value};

use niho_develop::Rendered;

/// `code` of a frame or arguments of the wrong shape.
pub const BAD_REQUEST: &str = "badRequest";
/// `code` of a method `serve` does not answer.
pub const UNKNOWN_METHOD: &str = "unknownMethod";
/// `code` of a handle no live Developer has.
pub const UNKNOWN_HANDLE: &str = "unknownHandle";
/// `code` of a new Developer past [`super::MAX_DEVELOPERS`].
pub const TOO_MANY_DEVELOPERS: &str = "tooManyDevelopers";
/// `code` of a bug (a panic; the Developer it used is let go).
pub const INTERNAL: &str = "internal";

/// A failed request: the engine's message without a `code` (the wasm's
/// `JsError` message), or one of the codes above.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fail {
    pub code: Option<&'static str>,
    pub message: String,
}

impl Fail {
    /// The engine refused the call (`niho_develop::api`'s message).
    pub fn call(message: String) -> Self {
        Self {
            code: None,
            message,
        }
    }

    pub fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::coded(BAD_REQUEST, message)
    }
}

/// A response: its header and the blobs its `result` names.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    header: Value,
    blobs: Vec<Vec<u8>>,
}

impl Reply {
    /// `{"ok":true,"result":<result>,"blobs":[...]}`.
    pub fn ok_with(result: Value, blobs: Vec<Vec<u8>>) -> Self {
        let sizes: Vec<usize> = blobs.iter().map(Vec::len).collect();
        Self {
            header: json!({"ok": true, "result": result, "blobs": sizes}),
            blobs,
        }
    }

    pub fn ok(result: Value) -> Self {
        Self::ok_with(result, Vec::new())
    }

    /// A string result (a JSON text is sent as the string, not parsed).
    pub fn text(text: String) -> Self {
        Self::ok(Value::String(text))
    }

    /// Bytes: `{"blob":0}`.
    pub fn bytes(bytes: Vec<u8>) -> Self {
        Self::ok_with(json!({"blob": 0}), vec![bytes])
    }

    /// `{"width","height","rgba":{"blob":0},"approximations":[...]}`.
    pub fn frame(frame: Rendered) -> Self {
        Self::ok_with(
            json!({
                "width": frame.width,
                "height": frame.height,
                "rgba": {"blob": 0},
                "approximations": frame.approximations,
            }),
            vec![frame.rgba],
        )
    }

    /// `{"width","height"}`.
    pub fn size(width: u32, height: u32) -> Self {
        Self::ok(json!({"width": width, "height": height}))
    }

    /// `{"ok":false,"error":<message>,"code"?:<code>}`.
    pub fn fail(fail: Fail) -> Self {
        let mut header = Map::new();
        header.insert("ok".into(), Value::Bool(false));
        header.insert("error".into(), Value::String(fail.message));
        if let Some(code) = fail.code {
            header.insert("code".into(), Value::from(code));
        }
        Self {
            header: Value::Object(header),
            blobs: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn header(&self) -> &Value {
        &self.header
    }

    pub fn blobs(&self) -> &[Vec<u8>] {
        &self.blobs
    }

    /// The `code` of a failed response.
    #[cfg(test)]
    pub fn code(&self) -> Option<&str> {
        self.header.get("code").and_then(Value::as_str)
    }

    /// The header's JSON text.
    pub fn header_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&self.header).expect("a JSON value serializes")
    }

    /// The whole body: header length, header, blobs.
    #[cfg(test)]
    pub fn encode(&self) -> Vec<u8> {
        let header = self.header_bytes();
        let mut body =
            Vec::with_capacity(4 + header.len() + self.blobs.iter().map(Vec::len).sum::<usize>());
        body.extend_from_slice(&(header.len() as u32).to_le_bytes());
        body.extend_from_slice(&header);
        for blob in &self.blobs {
            body.extend_from_slice(blob);
        }
        body
    }
}

impl From<Fail> for Reply {
    fn from(fail: Fail) -> Self {
        Self::fail(fail)
    }
}

/// A request body read: its arguments, `handle` and `client`.
#[derive(Debug)]
pub struct Request<'a> {
    pub args: Args<'a>,
    /// The Developer of a `Developer.*` method.
    pub handle: Option<u32>,
    /// The glue's token that `releaseClient` lets go of.
    pub client: Option<String>,
}

impl<'a> Request<'a> {
    /// Reads a body. An empty body is a request without arguments.
    pub fn parse(body: &'a [u8]) -> Result<Self, Fail> {
        if body.is_empty() {
            return Ok(Self {
                args: Args {
                    values: Vec::new(),
                    blobs: Vec::new(),
                },
                handle: None,
                client: None,
            });
        }
        let Some((length, rest)) = body.split_first_chunk::<4>() else {
            return Err(Fail::bad_request(
                "the body is shorter than its header length",
            ));
        };
        let length = u32::from_le_bytes(*length) as usize;
        if length > rest.len() {
            return Err(Fail::bad_request(format!(
                "the header length {length} is past the end of the body ({} bytes after it)",
                rest.len()
            )));
        }
        let (header, mut payload) = rest.split_at(length);
        let header: Value = serde_json::from_slice(header)
            .map_err(|e| Fail::bad_request(format!("the header is not JSON: {e}")))?;
        let Value::Object(mut header) = header else {
            return Err(Fail::bad_request("the header must be a JSON object"));
        };
        let values = match header.remove("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(values)) => values,
            Some(_) => return Err(Fail::bad_request("args must be an array")),
        };
        let sizes = match header.remove("blobs") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(sizes)) => sizes,
            Some(_) => return Err(Fail::bad_request("blobs must be an array")),
        };
        let mut blobs = Vec::with_capacity(sizes.len());
        for (i, size) in sizes.iter().enumerate() {
            let size = size
                .as_u64()
                .filter(|&n| n <= payload.len() as u64)
                .ok_or_else(|| {
                    Fail::bad_request(format!(
                        "blobs[{i}] must be a byte count within the payload ({} bytes left)",
                        payload.len()
                    ))
                })?;
            let (blob, rest) = payload.split_at(size as usize);
            blobs.push(blob);
            payload = rest;
        }
        if !payload.is_empty() {
            return Err(Fail::bad_request(format!(
                "the payload has {} bytes past its blobs",
                payload.len()
            )));
        }
        let handle = match header.remove("handle") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| Fail::bad_request("handle must be a u32"))?,
            ),
        };
        let client = match header.remove("client") {
            None | Some(Value::Null) => None,
            Some(Value::String(client)) => Some(client),
            Some(_) => return Err(Fail::bad_request("client must be a string")),
        };
        Ok(Self {
            args: Args { values, blobs },
            handle,
            client,
        })
    }
}

/// The arguments of a request, in the order of the wasm export's (`self`
/// left out). A binary argument is `{"blob":i}`; an optional one may be
/// `null` or left out at the end.
#[derive(Debug)]
pub struct Args<'a> {
    values: Vec<Value>,
    blobs: Vec<&'a [u8]>,
}

impl<'a> Args<'a> {
    /// `min..=max` arguments.
    pub fn expect(&self, min: usize, max: usize) -> Result<(), Fail> {
        let n = self.values.len();
        if (min..=max).contains(&n) {
            return Ok(());
        }
        Err(Fail::bad_request(if min == max {
            format!("takes {min} arguments, not {n}")
        } else {
            format!("takes {min} to {max} arguments, not {n}")
        }))
    }

    fn required(&self, i: usize) -> Result<&Value, Fail> {
        self.values
            .get(i)
            .ok_or_else(|| Fail::bad_request(format!("args[{i}] is missing")))
    }

    /// `None` when left out or `null`.
    fn optional(&self, i: usize) -> Option<&Value> {
        self.values.get(i).filter(|v| !v.is_null())
    }

    fn wrong(i: usize, what: &str) -> Fail {
        Fail::bad_request(format!("args[{i}] must be {what}"))
    }

    /// `{"blob":i}`: the bytes of blob `i`.
    pub fn blob(&self, i: usize) -> Result<&'a [u8], Fail> {
        let index = self
            .required(i)?
            .as_object()
            .filter(|o| o.len() == 1)
            .and_then(|o| o.get("blob"))
            .and_then(Value::as_u64)
            .ok_or_else(|| Self::wrong(i, "{\"blob\": <index>}"))?;
        usize::try_from(index)
            .ok()
            .and_then(|index| self.blobs.get(index).copied())
            .ok_or_else(|| {
                Fail::bad_request(format!(
                    "args[{i}] names blob {index}, but there are {}",
                    self.blobs.len()
                ))
            })
    }

    pub fn str(&self, i: usize) -> Result<&str, Fail> {
        self.required(i)?
            .as_str()
            .ok_or_else(|| Self::wrong(i, "a string"))
    }

    pub fn opt_str(&self, i: usize) -> Result<Option<&str>, Fail> {
        self.optional(i)
            .map(|v| v.as_str().ok_or_else(|| Self::wrong(i, "a string or null")))
            .transpose()
    }

    fn u32_of(i: usize, value: &Value) -> Result<u32, Fail> {
        value
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| Self::wrong(i, "an integer 0..=4294967295"))
    }

    pub fn u32(&self, i: usize) -> Result<u32, Fail> {
        Self::u32_of(i, self.required(i)?)
    }

    pub fn opt_u32(&self, i: usize) -> Result<Option<u32>, Fail> {
        self.optional(i).map(|v| Self::u32_of(i, v)).transpose()
    }

    pub fn u8(&self, i: usize) -> Result<u8, Fail> {
        self.required(i)?
            .as_u64()
            .and_then(|n| u8::try_from(n).ok())
            .ok_or_else(|| Self::wrong(i, "an integer 0..=255"))
    }

    pub fn i32(&self, i: usize) -> Result<i32, Fail> {
        self.required(i)?
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .ok_or_else(|| Self::wrong(i, "a 32-bit integer"))
    }

    pub fn f64(&self, i: usize) -> Result<f64, Fail> {
        self.required(i)?
            .as_f64()
            .ok_or_else(|| Self::wrong(i, "a number"))
    }

    pub fn bool(&self, i: usize) -> Result<bool, Fail> {
        self.required(i)?
            .as_bool()
            .ok_or_else(|| Self::wrong(i, "true or false"))
    }
}

#[cfg(test)]
mod tests {
    use super::{Fail, Reply, Request, BAD_REQUEST};
    use serde_json::{json, Value};

    fn body(header: &Value, payload: &[u8]) -> Vec<u8> {
        let header = serde_json::to_vec(header).unwrap();
        let mut body = (header.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(&header);
        body.extend_from_slice(payload);
        body
    }

    #[test]
    fn a_body_gives_its_arguments_blobs_handle_and_client() {
        let text = body(
            &json!({"args": [{"blob": 1}, "s", 7, null, {"blob": 0}], "blobs": [2, 3], "handle": 5, "client": "c"}),
            b"abcde",
        );
        let request = Request::parse(&text).unwrap();
        assert_eq!(request.handle, Some(5));
        assert_eq!(request.client.as_deref(), Some("c"));
        let args = &request.args;
        args.expect(5, 5).unwrap();
        assert_eq!(args.blob(0).unwrap(), b"cde");
        assert_eq!(args.blob(4).unwrap(), b"ab");
        assert_eq!(args.str(1).unwrap(), "s");
        assert_eq!(args.u32(2).unwrap(), 7);
        assert_eq!(args.opt_u32(3).unwrap(), None);
        assert_eq!(args.opt_str(9).unwrap(), None);
        assert_eq!(args.u8(2).unwrap(), 7);
        assert_eq!(args.i32(2).unwrap(), 7);
        assert_eq!(args.f64(2).unwrap(), 7.0);
        assert!(args.bool(2).is_err());
        assert!(args.str(2).is_err());
        assert!(args.blob(1).is_err());
        assert!(args.expect(1, 4).is_err());
        let empty = Request::parse(&[]).unwrap();
        empty.args.expect(0, 0).unwrap();
        assert_eq!(empty.handle, None);
    }

    #[test]
    fn a_malformed_body_is_a_bad_request() {
        let bad = |text: &[u8]| Request::parse(text).unwrap_err().code;
        assert_eq!(bad(&[1, 0]), Some(BAD_REQUEST));
        assert_eq!(bad(&[9, 0, 0, 0, b'{', b'}']), Some(BAD_REQUEST));
        assert_eq!(bad(&[3, 0, 0, 0, b'{', b'x', b'}']), Some(BAD_REQUEST));
        assert_eq!(bad(&body(&json!([1]), b"")), Some(BAD_REQUEST));
        assert_eq!(bad(&body(&json!({"args": 1}), b"")), Some(BAD_REQUEST));
        assert_eq!(
            bad(&body(&json!({"blobs": [4]}), b"abc")),
            Some(BAD_REQUEST)
        );
        assert_eq!(
            bad(&body(&json!({"blobs": [1]}), b"abc")),
            Some(BAD_REQUEST)
        );
        assert_eq!(bad(&body(&json!({"handle": -1}), b"")), Some(BAD_REQUEST));
        assert_eq!(bad(&body(&json!({"client": 1}), b"")), Some(BAD_REQUEST));
    }

    #[test]
    fn replies_name_their_blobs() {
        let reply = Reply::bytes(vec![1, 2, 3]);
        assert_eq!(
            reply.header(),
            &json!({"ok": true, "result": {"blob": 0}, "blobs": [3]})
        );
        let encoded = reply.encode();
        let length = u32::from_le_bytes(encoded[..4].try_into().unwrap()) as usize;
        assert_eq!(&encoded[4 + length..], &[1, 2, 3]);
        let failed = Reply::from(Fail::call("no".into()));
        assert_eq!(failed.header(), &json!({"ok": false, "error": "no"}));
        assert_eq!(failed.code(), None);
        let coded = Reply::from(Fail::bad_request("shape"));
        assert_eq!(coded.code(), Some(BAD_REQUEST));
    }
}
