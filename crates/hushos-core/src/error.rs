/// Why an operation refused. The message is written for the person using the
/// app, as the web's `CryptoError` messages are.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error), uniffi(flat_error))]
pub enum CoreError {
    /// A malformed argument: a wrong length, a bad encoding, an unsupported version.
    #[error("{0}")]
    Input(String),
    /// The OPAQUE protocol refused a message.
    #[error("{0}")]
    Opaque(String),
    /// An envelope did not open: the wrong key, the wrong context, or damaged bytes.
    #[error("{0}")]
    Sealed(String),
}

pub type CoreResult<T> = Result<T, CoreError>;

pub(crate) fn input(message: impl Into<String>) -> CoreError {
    CoreError::Input(message.into())
}
