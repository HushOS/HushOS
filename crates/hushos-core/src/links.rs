//! A public link, as `packages/crypto/links.ts` writes it: a share without a
//! grantee. The 32-byte secret rides in the URL fragment and never reaches the
//! server; an optional password is stretched with argon2id under a per-link
//! salt (32 zero bytes stand in without one); BLAKE2b over the two gives the
//! key that seals the node key with the link's context as associated data.
//! The owner keeps the secret, the path token and the stretched password key
//! sealed under the node key, so the URL can be shown again and the link
//! survives a rotation without the password.

use crate::bytes::{decode, encode, expect_len, random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::envelope::{context, open, seal};
use crate::error::{input, CoreError, CoreResult};
use argon2::{Algorithm, Argon2, Params, Version};
use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest as _};
use serde_json::json;

pub(crate) const LINK_SECRET_BYTES: usize = 32;
pub(crate) const LINK_TOKEN_BYTES: usize = 32;
pub(crate) const LINK_SALT_BYTES: usize = 16;
const LINK_ENVELOPE_BYTES: usize = NONCE_BYTES + KEY_BYTES + TAG_BYTES; // 72
const SECRET_ENVELOPE_BYTES: usize =
    NONCE_BYTES + LINK_SECRET_BYTES + LINK_TOKEN_BYTES + KEY_BYTES + TAG_BYTES; // 136
const SECRET_ENVELOPE_LEGACY_BYTES: usize = NONCE_BYTES + LINK_SECRET_BYTES + LINK_TOKEN_BYTES + TAG_BYTES; // 104

/// What binds a link to its node and epoch.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct LinkContext {
    pub workspace_id: String,
    pub node_id: String,
    pub key_epoch: u64,
    pub link_id: String,
}

fn link_context(ctx: &LinkContext, purpose: &str) -> Vec<u8> {
    context(&[
        json!(purpose),
        json!(1),
        json!(ctx.workspace_id.to_lowercase()),
        json!(ctx.node_id.to_lowercase()),
        json!(ctx.key_epoch),
        json!(ctx.link_id.to_lowercase()),
    ])
}

/// The password's contribution to a link key: argon2id (64 MiB, 3 passes, 4
/// lanes, the account layer's profile) under the link's 16-byte salt, or 32
/// zero bytes for a link without a password.
///
/// ```
/// use hushos_core::link_password_key;
/// let salt = vec![7u8; 16];
/// assert_eq!(link_password_key(None, salt.clone())?, vec![0u8; 32]);
/// let stretched = link_password_key(Some("open sesame".into()), salt.clone())?;
/// assert_eq!(stretched.len(), 32);
/// assert_eq!(link_password_key(Some("open sesame".into()), salt)?, stretched);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_password_key(password: Option<String>, salt: Vec<u8>) -> CoreResult<Vec<u8>> {
    expect_len("link salt", &salt, LINK_SALT_BYTES).map_err(|_| input("Invalid link salt."))?;
    let Some(password) = password else { return Ok(vec![0u8; KEY_BYTES]) };
    let params = Params::new(65_536, 3, 4, Some(KEY_BYTES)).map_err(|_| input("argon2 parameters"))?;
    let mut out = vec![0u8; KEY_BYTES];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .map_err(|_| input("argon2 failed"))?;
    Ok(out)
}

/* The link key: BLAKE2b-256 over the secret and the stretched password key. */
fn link_key(secret: &[u8], from_password: &[u8]) -> CoreResult<[u8; KEY_BYTES]> {
    expect_len("link secret", secret, LINK_SECRET_BYTES).map_err(|_| input("Invalid link secret."))?;
    expect_len("link password key", from_password, KEY_BYTES)
        .map_err(|_| input("Invalid link password key."))?;
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(secret);
    hasher.update(from_password);
    Ok(hasher.finalize().into())
}

/// The node key sealed under the link key: the 72-byte `linkEnvelope` the server stores.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_seal(
    ctx: LinkContext,
    node_key: Vec<u8>,
    secret: Vec<u8>,
    from_password: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    expect_len("node key", &node_key, KEY_BYTES)?;
    let key = link_key(&secret, &from_password)?;
    seal(&key, &node_key, &link_context(&ctx, "hushos/drive/link"))
}

/// What a visitor does with the URL: the secret from the fragment, the
/// password they typed (or none), and the salt and envelope the server sent
/// back for the token, opened to the node key.
///
/// ```
/// use hushos_core::{link_open, link_password_key, link_seal, random_bytes, LinkContext};
/// let ctx = LinkContext { workspace_id: "ws".into(), node_id: "node".into(), key_epoch: 2, link_id: "link".into() };
/// let (node_key, secret, salt) = (random_bytes(32)?, random_bytes(32)?, random_bytes(16)?);
/// let from_password = link_password_key(Some("open sesame".into()), salt.clone())?;
/// let envelope = link_seal(ctx.clone(), node_key.clone(), secret.clone(), from_password)?;
/// assert_eq!(link_open(ctx.clone(), envelope.clone(), secret.clone(), Some("open sesame".into()), salt.clone())?, node_key);
/// assert!(link_open(ctx, envelope, secret, Some("wrong".into()), salt).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_open(
    ctx: LinkContext,
    envelope: Vec<u8>,
    secret: Vec<u8>,
    password: Option<String>,
    salt: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    if envelope.len() != LINK_ENVELOPE_BYTES {
        return Err(input("Invalid link envelope."));
    }
    let key = link_key(&secret, &link_password_key(password, salt)?)?;
    let opened = open(&key, &envelope, &link_context(&ctx, "hushos/drive/link"))
        .map_err(|_| CoreError::Sealed("This link could not be opened. The password may be wrong.".into()))?;
    expect_len("node key", &opened, KEY_BYTES)
        .map_err(|_| CoreError::Sealed("Invalid link envelope.".into()))?;
    Ok(opened)
}

/// The owner's copy of what makes a link, opened from its `secretEnvelope`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct LinkSecret {
    /// The URL fragment, 32 bytes.
    pub secret: Vec<u8>,
    /// The path token, 32 bytes.
    pub token: Vec<u8>,
    /// The stretched password key; absent on envelopes from before it was kept.
    pub from_password: Option<Vec<u8>>,
}

/// Seals the owner's copy under the node key: the 136-byte `secretEnvelope`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_secret_seal(
    ctx: LinkContext,
    node_key: Vec<u8>,
    secret: Vec<u8>,
    token: Vec<u8>,
    from_password: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    expect_len("node key", &node_key, KEY_BYTES)?;
    expect_len("link secret", &secret, LINK_SECRET_BYTES).map_err(|_| input("Invalid link secret."))?;
    expect_len("link token", &token, LINK_TOKEN_BYTES).map_err(|_| input("Invalid link secret."))?;
    expect_len("link password key", &from_password, KEY_BYTES).map_err(|_| input("Invalid link secret."))?;
    let mut plaintext = Vec::with_capacity(LINK_SECRET_BYTES + LINK_TOKEN_BYTES + KEY_BYTES);
    plaintext.extend_from_slice(&secret);
    plaintext.extend_from_slice(&token);
    plaintext.extend_from_slice(&from_password);
    seal(&node_key, &plaintext, &link_context(&ctx, "hushos/drive/link-secret"))
}

/// Opens the owner's copy: what shows the URL again or re-seals the link.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_secret_open(ctx: LinkContext, node_key: Vec<u8>, envelope: Vec<u8>) -> CoreResult<LinkSecret> {
    expect_len("node key", &node_key, KEY_BYTES)?;
    if envelope.len() != SECRET_ENVELOPE_BYTES && envelope.len() != SECRET_ENVELOPE_LEGACY_BYTES {
        return Err(input("Invalid link secret envelope."));
    }
    let plaintext = open(&node_key, &envelope, &link_context(&ctx, "hushos/drive/link-secret"))?;
    let secret = plaintext[..LINK_SECRET_BYTES].to_vec();
    let token = plaintext[LINK_SECRET_BYTES..LINK_SECRET_BYTES + LINK_TOKEN_BYTES].to_vec();
    let rest = &plaintext[LINK_SECRET_BYTES + LINK_TOKEN_BYTES..];
    let from_password = if rest.is_empty() { None } else { Some(rest.to_vec()) };
    Ok(LinkSecret { secret, token, from_password })
}

/// Everything the owner posts to `POST /api/drive/nodes/:id/links`, encoded.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CreatedLink {
    /// The path token, base64url: the URL is `{origin}/s/{token}#{secret}`.
    pub token: String,
    /// The fragment secret, base64url.
    pub secret: String,
    pub link_salt: String,
    pub link_envelope: String,
    pub secret_envelope: String,
    pub has_password: bool,
}

/// Mints a link for a node the owner holds the key of: fresh secret, token
/// and salt, the node key sealed under the link key, and the owner's copy
/// sealed under the node key. `ctx.link_id` is the id the owner chose.
///
/// ```
/// use hushos_core::{base64url_decode, link_create, link_open, random_bytes, LinkContext};
/// let ctx = LinkContext { workspace_id: "ws".into(), node_id: "node".into(), key_epoch: 1, link_id: "link".into() };
/// let node_key = random_bytes(32)?;
/// let link = link_create(ctx.clone(), node_key.clone(), None)?;
/// assert!(!link.has_password);
/// let opened = link_open(ctx, base64url_decode(link.link_envelope)?, base64url_decode(link.secret)?, None, base64url_decode(link.link_salt)?)?;
/// assert_eq!(opened, node_key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_create(ctx: LinkContext, node_key: Vec<u8>, password: Option<String>) -> CoreResult<CreatedLink> {
    if password.as_deref().is_some_and(str::is_empty) {
        return Err(input("A link password cannot be empty."));
    }
    let secret = random(LINK_SECRET_BYTES);
    let token = random(LINK_TOKEN_BYTES);
    let salt = random(LINK_SALT_BYTES);
    let has_password = password.is_some();
    let from_password = link_password_key(password, salt.clone())?;
    let link_envelope = link_seal(ctx.clone(), node_key.clone(), secret.clone(), from_password.clone())?;
    let secret_envelope = link_secret_seal(ctx, node_key, secret.clone(), token.clone(), from_password)?;
    Ok(CreatedLink {
        token: encode(&token),
        secret: encode(&secret),
        link_salt: encode(&salt),
        link_envelope: encode(&link_envelope),
        secret_envelope: encode(&secret_envelope),
        has_password,
    })
}

/// The same link under a new password (or none): what `PATCH /api/drive/links/:id`
/// takes as `seal`. The secret and token stay, so the URL does not change.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_reseal(
    ctx: LinkContext,
    node_key: Vec<u8>,
    secret_envelope: Vec<u8>,
    password: Option<String>,
) -> CoreResult<CreatedLink> {
    if password.as_deref().is_some_and(str::is_empty) {
        return Err(input("A link password cannot be empty."));
    }
    let owned = link_secret_open(ctx.clone(), node_key.clone(), secret_envelope)?;
    let salt = random(LINK_SALT_BYTES);
    let has_password = password.is_some();
    let from_password = link_password_key(password, salt.clone())?;
    let link_envelope =
        link_seal(ctx.clone(), node_key.clone(), owned.secret.clone(), from_password.clone())?;
    let secret_envelope =
        link_secret_seal(ctx, node_key, owned.secret.clone(), owned.token.clone(), from_password)?;
    Ok(CreatedLink {
        token: encode(&owned.token),
        secret: encode(&owned.secret),
        link_salt: encode(&salt),
        link_envelope: encode(&link_envelope),
        secret_envelope: encode(&secret_envelope),
        has_password,
    })
}

/// The URL a visitor opens, from what [`link_create`] returned.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_url(origin: String, token: String, secret: String) -> CoreResult<String> {
    decode("token", &token, Some(LINK_TOKEN_BYTES))?;
    decode("secret", &secret, Some(LINK_SECRET_BYTES))?;
    Ok(format!("{}/s/{token}#{secret}", origin.trim_end_matches('/')))
}

/// The token and secret out of a link URL, or an error when it is not one.
///
/// ```
/// use hushos_core::{base64url_encode, link_parse, link_url};
/// let (token, secret) = (base64url_encode(vec![1; 32]), base64url_encode(vec![2; 32]));
/// let url = link_url("https://hushos.app/".into(), token.clone(), secret.clone())?;
/// assert_eq!(url, format!("https://hushos.app/s/{token}#{secret}"));
/// let parts = link_parse(url)?;
/// assert_eq!((parts.token, parts.secret), (token, secret));
/// assert!(link_parse("https://hushos.app/app/drive".into()).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn link_parse(url: String) -> CoreResult<LinkParts> {
    let (rest, secret) = url
        .split_once('#')
        .ok_or_else(|| input("This is not a HushOS link: the secret after # is missing."))?;
    let token =
        rest.rsplit_once("/s/").map(|(_, token)| token).ok_or_else(|| input("This is not a HushOS link."))?;
    let token = token.split(['?', '/']).next().unwrap_or_default().to_string();
    decode("token", &token, Some(LINK_TOKEN_BYTES)).map_err(|_| input("This is not a HushOS link."))?;
    decode("secret", secret, Some(LINK_SECRET_BYTES)).map_err(|_| input("This is not a HushOS link."))?;
    Ok(LinkParts { token, secret: secret.to_string() })
}

/// The two halves of a link URL.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct LinkParts {
    pub token: String,
    pub secret: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::base64url_decode;

    fn ctx() -> LinkContext {
        LinkContext {
            workspace_id: "WS".into(),
            node_id: "Node".into(),
            key_epoch: 3,
            link_id: "Link".into(),
        }
    }

    #[test]
    fn contexts_lowercase_the_ids_and_name_the_purpose() {
        assert_eq!(
            link_context(&ctx(), "hushos/drive/link"),
            br#"["hushos/drive/link",1,"ws","node",3,"link"]"#
        );
        assert_eq!(
            link_context(&ctx(), "hushos/drive/link-secret"),
            br#"["hushos/drive/link-secret",1,"ws","node",3,"link"]"#
        );
    }

    #[test]
    fn a_created_link_opens_for_a_visitor_and_its_owner_copy_reopens_and_reseals() {
        let node_key = random(32);
        let link = link_create(ctx(), node_key.clone(), Some("open sesame".into())).unwrap();
        assert!(link.has_password);
        let envelope = base64url_decode(link.link_envelope.clone()).unwrap();
        let salt = base64url_decode(link.link_salt.clone()).unwrap();
        let secret = base64url_decode(link.secret.clone()).unwrap();
        assert_eq!(envelope.len(), LINK_ENVELOPE_BYTES);
        assert_eq!(
            link_open(ctx(), envelope.clone(), secret.clone(), Some("open sesame".into()), salt.clone())
                .unwrap(),
            node_key
        );
        assert!(matches!(
            link_open(ctx(), envelope.clone(), secret.clone(), None, salt.clone()),
            Err(CoreError::Sealed(_))
        ));
        let mut other = ctx();
        other.key_epoch = 4;
        assert!(matches!(
            link_open(other, envelope, secret.clone(), Some("open sesame".into()), salt),
            Err(CoreError::Sealed(_))
        ));

        let owned = link_secret_open(
            ctx(),
            node_key.clone(),
            base64url_decode(link.secret_envelope.clone()).unwrap(),
        )
        .unwrap();
        assert_eq!(owned.secret, secret);
        assert_eq!(owned.token, base64url_decode(link.token.clone()).unwrap());
        let stretched = owned.from_password.expect("the password key is kept");
        assert_eq!(
            link_password_key(Some("open sesame".into()), base64url_decode(link.link_salt).unwrap()).unwrap(),
            stretched
        );

        // Dropping the password keeps the URL and opens without one.
        let resealed =
            link_reseal(ctx(), node_key.clone(), base64url_decode(link.secret_envelope).unwrap(), None)
                .unwrap();
        assert_eq!((resealed.token, resealed.secret), (link.token, link.secret));
        assert!(!resealed.has_password);
        assert_eq!(
            link_open(
                ctx(),
                base64url_decode(resealed.link_envelope).unwrap(),
                owned.secret,
                None,
                base64url_decode(resealed.link_salt).unwrap()
            )
            .unwrap(),
            node_key
        );
    }

    #[test]
    fn a_legacy_owner_copy_without_the_password_key_opens_with_none() {
        let node_key = random(32);
        let (secret, token) = (random(32), random(32));
        let mut plaintext = secret.clone();
        plaintext.extend_from_slice(&token);
        let envelope =
            seal(&node_key, &plaintext, &link_context(&ctx(), "hushos/drive/link-secret")).unwrap();
        assert_eq!(envelope.len(), SECRET_ENVELOPE_LEGACY_BYTES);
        let owned = link_secret_open(ctx(), node_key, envelope).unwrap();
        assert_eq!((owned.secret, owned.token, owned.from_password), (secret, token, None));
    }

    #[test]
    fn wrong_sizes_and_empty_passwords_are_refused() {
        assert!(matches!(link_password_key(None, vec![0; 15]), Err(CoreError::Input(_))));
        assert!(matches!(link_create(ctx(), random(32), Some(String::new())), Err(CoreError::Input(_))));
        assert!(matches!(
            link_open(ctx(), vec![0; 71], random(32), None, random(16)),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(link_secret_open(ctx(), random(32), vec![0; 120]), Err(CoreError::Input(_))));
    }
}
