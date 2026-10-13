//! The OPAQUE client, as `@serenity-kit/opaque` does it: the same cipher suite,
//! key stretching, encodings and error texts, so a password registered on the
//! web logs in here and the other way round. The HushOS profile (the server
//! identifier and the argon2id parameters from `packages/crypto/protocol.ts`)
//! is built in; there is no way to call this with another.

use crate::bytes::{decode, encode, Redacted, SecretBytes};
use crate::error::{CoreError, CoreResult};
use argon2::{Algorithm, Argon2, ParamsBuilder, Version};
use generic_array::{ArrayLength, GenericArray};
use opaque_ke::ciphersuite::CipherSuite;
use opaque_ke::errors::{InternalError, ProtocolError};
use opaque_ke::ksf::Ksf;
use opaque_ke::rand::rngs::OsRng;
use opaque_ke::{
    ClientLogin, ClientLoginFinishParameters, ClientRegistration, ClientRegistrationFinishParameters,
    CredentialResponse, Identifiers, RegistrationResponse,
};
use std::fmt;
use unicode_normalization::UnicodeNormalization as _;
use zeroize::Zeroizing;

const SERVER_IDENTIFIER: &[u8] = b"hushos/opaque/profile/1";
const ARGON_ITERATIONS: u32 = 3;
const ARGON_MEMORY_KIB: u32 = 65_536;
const ARGON_PARALLELISM: u32 = 4;

struct Suite;

impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2::Sha512>;
    type Ksf = Stretching;
}

/* argon2id over the OPAQUE randomized password, with serenity's fixed zero salt. */
struct Stretching {
    argon: Argon2<'static>,
}

impl Default for Stretching {
    fn default() -> Self {
        Self::hushos().expect("the built-in argon2id parameters are valid")
    }
}

impl Stretching {
    fn hushos() -> CoreResult<Self> {
        let mut builder = ParamsBuilder::default();
        builder.t_cost(ARGON_ITERATIONS);
        builder.m_cost(ARGON_MEMORY_KIB);
        builder.p_cost(ARGON_PARALLELISM);
        let params = builder
            .build()
            .map_err(|_| CoreError::Opaque("Invalid keyStretching (argon2id) combination".into()))?;
        Ok(Self { argon: Argon2::new(Algorithm::Argon2id, Version::V0x13, params) })
    }
}

impl Ksf for Stretching {
    fn hash<L: ArrayLength<u8>>(
        &self,
        input: GenericArray<u8, L>,
    ) -> Result<GenericArray<u8, L>, InternalError> {
        let mut output = GenericArray::default();
        self.argon
            .hash_password_into(&input, &[0; argon2::RECOMMENDED_SALT_LEN], &mut output)
            .map_err(|_| InternalError::KsfError)?;
        Ok(output)
    }
}

fn protocol(context: &'static str) -> impl Fn(ProtocolError) -> CoreError {
    move |error| CoreError::Opaque(format!("opaque protocol error at \"{context}\"; {error:?}"))
}

fn identifiers() -> Identifiers<'static> {
    Identifiers { client: None, server: Some(SERVER_IDENTIFIER) }
}

/// The first login message and the state the second step needs.
#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct LoginStart {
    /// Keep in memory only; it holds the blinded password.
    pub state: SecretBytes,
    /// Send as `startLoginRequest`.
    pub request: String,
}

/// What a correct password yields once the server has answered.
#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct LoginFinish {
    /// Send as `finishLoginRequest`.
    pub request: String,
    pub session_key: SecretBytes,
    /// Unwraps the account key; see `account_unlock`.
    pub export_key: SecretBytes,
    pub server_static_public_key: String,
}

#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RegistrationStart {
    pub state: SecretBytes,
    /// Send as `registrationRequest`.
    pub request: String,
}

#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RegistrationFinish {
    /// Send as `registrationRecord`.
    pub record: String,
    pub export_key: SecretBytes,
    pub server_static_public_key: String,
}

/* Debug by hand: the states hold the blinded password, the keys open the account. UniFFI records
 * cannot implement Drop, so their secret fields are SecretBytes, which wipe themselves. */
impl fmt::Debug for LoginStart {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginStart").field("state", &Redacted).field("request", &self.request).finish()
    }
}

impl fmt::Debug for LoginFinish {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginFinish")
            .field("request", &self.request)
            .field("session_key", &Redacted)
            .field("export_key", &Redacted)
            .field("server_static_public_key", &self.server_static_public_key)
            .finish()
    }
}

impl fmt::Debug for RegistrationStart {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegistrationStart").field("state", &Redacted).field("request", &self.request).finish()
    }
}

impl fmt::Debug for RegistrationFinish {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegistrationFinish")
            .field("record", &self.record)
            .field("export_key", &Redacted)
            .field("server_static_public_key", &self.server_static_public_key)
            .finish()
    }
}

/* Every password goes into OPAQUE in Unicode NFC, as the web does, so the same
 * characters typed through different input methods open the same account. */
fn normalized(password: String) -> Zeroizing<String> {
    let password = Zeroizing::new(password);
    Zeroizing::new(password.nfc().collect())
}

/// Step one of a login: blind the password. Send `request` to
/// `POST /api/auth/login/start` and keep `state` for [`opaque_finish_login`].
///
/// ```no_run
/// # fn post(_path: &str, _body: &str) -> String { unimplemented!() }
/// use hushos_core::{opaque_start_login, opaque_finish_login};
/// let start = opaque_start_login("correct horse".into())?;
/// let login_response = post("/api/auth/login/start", &start.request);
/// match opaque_finish_login("correct horse".into(), start.state.to_vec(), login_response)? {
///     Some(finish) => { post("/api/auth/login/finish", &finish.request); }
///     None => eprintln!("wrong password"),
/// }
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn opaque_start_login(password: String) -> CoreResult<LoginStart> {
    let password = normalized(password);
    let start = ClientLogin::<Suite>::start(&mut OsRng, password.as_bytes())
        .map_err(protocol("start client login"))?;
    Ok(LoginStart {
        state: start.state.serialize().to_vec().into(),
        request: encode(&start.message.serialize()),
    })
}

/// `None` is a wrong password (the client detects it before the server does),
/// not an error.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn opaque_finish_login(
    password: String,
    state: Vec<u8>,
    login_response: String,
) -> CoreResult<Option<LoginFinish>> {
    let (password, state) = (normalized(password), Zeroizing::new(state));
    let response = decode("loginResponse", &login_response, None)?;
    let state =
        ClientLogin::<Suite>::deserialize(&state).map_err(protocol("deserialize clientLoginState"))?;
    let stretching = Stretching::hushos()?;
    let parameters = ClientLoginFinishParameters::new(None, identifiers(), Some(&stretching));
    let response =
        CredentialResponse::deserialize(&response).map_err(protocol("deserialize loginResponse"))?;
    let Ok(finish) = state.finish(&mut OsRng, password.as_bytes(), response, parameters) else {
        return Ok(None);
    };
    Ok(Some(LoginFinish {
        request: encode(&finish.message.serialize()),
        session_key: finish.session_key.to_vec().into(),
        export_key: finish.export_key.to_vec().into(),
        server_static_public_key: encode(&finish.server_s_pk.serialize()),
    }))
}

/// Step one of a registration; send `request` as `registrationRequest`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn opaque_start_registration(password: String) -> CoreResult<RegistrationStart> {
    let password = normalized(password);
    let start = ClientRegistration::<Suite>::start(&mut OsRng, password.as_bytes())
        .map_err(protocol("start client registration"))?;
    Ok(RegistrationStart {
        state: start.state.serialize().to_vec().into(),
        request: encode(&start.message.serialize()),
    })
}

/// Step two of a registration; send `record` as `registrationRecord`. Unlike
/// a login, a registration cannot detect a typo: the record is what the server
/// will check later passwords against.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn opaque_finish_registration(
    password: String,
    state: Vec<u8>,
    registration_response: String,
) -> CoreResult<RegistrationFinish> {
    let (password, state) = (normalized(password), Zeroizing::new(state));
    let response = decode("registrationResponse", &registration_response, None)?;
    let state = ClientRegistration::<Suite>::deserialize(&state)
        .map_err(protocol("deserialize clientRegistrationState"))?;
    let stretching = Stretching::hushos()?;
    let parameters = ClientRegistrationFinishParameters::new(identifiers(), Some(&stretching));
    let response =
        RegistrationResponse::deserialize(&response).map_err(protocol("deserialize registrationResponse"))?;
    let finish = state
        .finish(&mut OsRng, password.as_bytes(), response, parameters)
        .map_err(protocol("finish client registration"))?;
    Ok(RegistrationFinish {
        record: encode(&finish.message.serialize()),
        export_key: finish.export_key.to_vec().into(),
        server_static_public_key: encode(&finish.server_s_pk.serialize()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::decode;
    use opaque_ke::{
        CredentialFinalization, CredentialRequest, RegistrationRequest, RegistrationUpload, ServerLogin,
        ServerLoginParameters, ServerRegistration, ServerSetup,
    };

    /* A server with the HushOS profile, as `packages/auth` runs it. */
    struct Server {
        setup: ServerSetup<Suite>,
        record: Option<ServerRegistration<Suite>>,
    }

    impl Server {
        fn new() -> Self {
            Self { setup: ServerSetup::<Suite>::new(&mut OsRng), record: None }
        }

        fn register(&mut self, password: &str) -> RegistrationFinish {
            let start = opaque_start_registration(password.into()).unwrap();
            let request =
                RegistrationRequest::deserialize(&decode("r", &start.request, None).unwrap()).unwrap();
            let response =
                ServerRegistration::<Suite>::start(&self.setup, request, b"user@example.com").unwrap();
            let finish = opaque_finish_registration(
                password.into(),
                start.state.to_vec(),
                encode(&response.message.serialize()),
            )
            .unwrap();
            let upload =
                RegistrationUpload::deserialize(&decode("u", &finish.record, None).unwrap()).unwrap();
            self.record = Some(ServerRegistration::finish(upload));
            finish
        }

        /* The server's session key when the client's finish message verifies, as the API's finish route checks. */
        fn login(&self, password: &str) -> Option<(LoginFinish, Vec<u8>)> {
            let start = opaque_start_login(password.into()).unwrap();
            let request =
                CredentialRequest::deserialize(&decode("r", &start.request, None).unwrap()).unwrap();
            let parameters = || ServerLoginParameters { context: None, identifiers: identifiers() };
            let response = ServerLogin::<Suite>::start(
                &mut OsRng,
                &self.setup,
                self.record.clone(),
                request,
                b"user@example.com",
                parameters(),
            )
            .unwrap();
            let finish = opaque_finish_login(
                password.into(),
                start.state.to_vec(),
                encode(&response.message.serialize()),
            )
            .unwrap()?;
            let finalization =
                CredentialFinalization::deserialize(&decode("f", &finish.request, None).unwrap()).unwrap();
            let server = response.state.finish(finalization, parameters()).unwrap();
            Some((finish, server.session_key.to_vec()))
        }
    }

    #[test]
    fn registration_then_login_agree_on_the_session_and_export_keys() {
        let mut server = Server::new();
        let registered = server.register("correct horse battery staple");
        let (login, server_session) =
            server.login("correct horse battery staple").expect("the right password logs in");
        assert_eq!(login.session_key, server_session, "both sides derive the same session key");
        assert_eq!(login.export_key, registered.export_key, "the export key is stable across logins");
        assert_eq!(login.server_static_public_key, registered.server_static_public_key);
        assert_eq!(login.export_key.len(), 64);
    }

    #[test]
    fn debug_prints_show_neither_the_login_state_nor_the_keys() {
        use crate::bytes::shows;
        let mut server = Server::new();
        let registered = server.register("correct horse battery staple");
        let (login, _) = server.login("correct horse battery staple").unwrap();
        let start = opaque_start_login("correct horse battery staple".into()).unwrap();
        let registration = opaque_start_registration("correct horse battery staple".into()).unwrap();
        for (printed, secret) in [
            (format!("{start:?}"), &start.state),
            (format!("{registration:?}"), &registration.state),
            (format!("{login:?}"), &login.session_key),
            (format!("{login:?}"), &login.export_key),
            (format!("{registered:?}"), &registered.export_key),
        ] {
            assert!(!shows(&printed, secret), "{printed}");
            assert!(printed.contains("<redacted>"));
        }
        assert!(format!("{login:?}").contains(&login.request), "the public message still prints");
    }

    #[test]
    fn a_wrong_password_is_none_not_an_error() {
        let mut server = Server::new();
        server.register("correct horse battery staple");
        assert!(server.login("correct horse battery stable").is_none());
    }

    #[test]
    fn a_password_typed_composed_opens_an_account_registered_decomposed() {
        // "café" as e + combining acute, then as the single é: one password after NFC, as on the web.
        let mut server = Server::new();
        let registered = server.register("cafe\u{301} au lait, please");
        let (login, _) = server.login("caf\u{e9} au lait, please").expect("NFC makes them one password");
        assert_eq!(login.export_key, registered.export_key);
        assert!(server.login("cafe au lait, please").is_none(), "a different letter is a different password");
    }

    #[test]
    fn an_unknown_account_looks_like_a_wrong_password() {
        // The server answers with a fake record so enumeration is not possible; the client just fails.
        let server = Server::new();
        assert!(server.login("anything").is_none());
    }

    #[test]
    fn malformed_wire_messages_are_input_or_opaque_errors() {
        let start = opaque_start_login("pw".into()).unwrap();
        assert!(matches!(
            opaque_finish_login("pw".into(), start.state.to_vec(), "not base64!".into()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(
            opaque_finish_login("pw".into(), start.state.to_vec(), "AAAA".into()),
            Err(CoreError::Opaque(_))
        ));
        assert!(matches!(
            opaque_finish_login("pw".into(), vec![1, 2, 3], "AAAA".into()),
            Err(CoreError::Opaque(_))
        ));
    }
}
