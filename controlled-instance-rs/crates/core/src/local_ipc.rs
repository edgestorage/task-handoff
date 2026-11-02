use std::{
    fmt, io,
    path::{Path, PathBuf},
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::fs_permissions::restrict_path;

const DEFAULT_SOCKET_FILE: &str = "ipc.sock";
const DEFAULT_HASH_LENGTH: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalIpcTransport {
    UnixSocket,
    NamedPipe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalIpcEndpoint {
    path: PathBuf,
    transport: LocalIpcTransport,
}

impl LocalIpcEndpoint {
    pub fn explicit(path: impl Into<PathBuf>) -> io::Result<Self> {
        let path = path.into();
        let value = path.to_string_lossy();
        if value.trim().is_empty() || value.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "local IPC path must be non-empty and cannot contain NUL bytes",
            ));
        }
        let transport = if is_named_pipe_path(&value) {
            LocalIpcTransport::NamedPipe
        } else {
            platform_transport()
        };
        let endpoint = Self { path, transport };
        endpoint.validate()?;
        Ok(endpoint)
    }

    pub fn generated(scope: &str, key: &str, explicit: Option<PathBuf>) -> io::Result<Self> {
        if let Some(path) = explicit.filter(|path| !path.as_os_str().is_empty()) {
            return Self::explicit(path);
        }
        validate_scope(scope)?;
        validate_key(key)?;
        let scope_name = scope_name(scope, key, DEFAULT_HASH_LENGTH)?;
        Self::from_generated_parts(&scope_name, DEFAULT_SOCKET_FILE)
    }

    /// Builds an endpoint with a published scope name instead of the derived
    /// `<scope>-<hash>` name. This keeps compatibility with endpoints whose
    /// directory and named-pipe names predate [`Self::generated`].
    pub fn generated_with_scope_name(
        scope_name: &str,
        file_name: &str,
        explicit: Option<PathBuf>,
    ) -> io::Result<Self> {
        if let Some(path) = explicit.filter(|path| !path.as_os_str().is_empty()) {
            return Self::explicit(path);
        }
        validate_scope_name(scope_name)?;
        validate_file_name(file_name)?;
        Self::from_generated_parts(scope_name, file_name)
    }

    fn from_generated_parts(scope_name: &str, file_name: &str) -> io::Result<Self> {
        let endpoint = match platform_transport() {
            LocalIpcTransport::NamedPipe => Self {
                path: PathBuf::from(format!(r"\\.\pipe\{scope_name}")),
                transport: LocalIpcTransport::NamedPipe,
            },
            LocalIpcTransport::UnixSocket => Self {
                path: temporary_root().join(scope_name).join(file_name),
                transport: LocalIpcTransport::UnixSocket,
            },
        };
        endpoint.validate()?;
        Ok(endpoint)
    }

    pub fn in_directory(
        directory: &Path,
        scope: &str,
        key: &str,
        file_name: &str,
    ) -> io::Result<Self> {
        validate_scope(scope)?;
        validate_key(key)?;
        validate_file_name(file_name)?;
        let endpoint = match platform_transport() {
            LocalIpcTransport::NamedPipe => Self {
                path: PathBuf::from(format!(
                    r"\\.\pipe\{}",
                    scope_name(scope, key, DEFAULT_HASH_LENGTH)?
                )),
                transport: LocalIpcTransport::NamedPipe,
            },
            LocalIpcTransport::UnixSocket => Self {
                path: directory.join(file_name),
                transport: LocalIpcTransport::UnixSocket,
            },
        };
        endpoint.validate()?;
        Ok(endpoint)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn path_string(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    pub fn transport(&self) -> LocalIpcTransport {
        self.transport
    }

    pub fn filesystem_backed(&self) -> bool {
        self.transport == LocalIpcTransport::UnixSocket
    }

    pub fn prepare(&self) -> io::Result<()> {
        if !self.filesystem_backed() {
            return Ok(());
        }
        self.validate()?;
        let directory = self.path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "local IPC path has no parent")
        })?;
        std::fs::create_dir_all(directory)?;
        restrict_path(directory, 0o700)?;
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn cleanup(&self) -> io::Result<()> {
        if !self.filesystem_backed() {
            return Ok(());
        }
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn validate(&self) -> io::Result<()> {
        if self.transport == LocalIpcTransport::UnixSocket {
            let limit = unix_socket_path_limit();
            let length = self.path.as_os_str().as_encoded_bytes().len();
            if length > limit {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "local IPC socket path exceeds the {limit}-byte limit: {}",
                        self.path.display()
                    ),
                ));
            }
        }
        Ok(())
    }
}

pub fn temporary_root() -> PathBuf {
    if cfg!(target_os = "macos") {
        return PathBuf::from("/private/tmp");
    }
    let root = std::env::temp_dir();
    std::fs::canonicalize(&root).unwrap_or(root)
}

pub fn create_private_temporary_directory(parent: &Path, prefix: &str) -> io::Result<PathBuf> {
    std::fs::create_dir_all(parent)?;
    let path = parent.join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&path)?;
    restrict_path(&path, 0o700)?;
    Ok(path)
}

pub async fn connect(endpoint: &LocalIpcEndpoint) -> io::Result<LocalIpcStream> {
    endpoint.validate()?;
    match endpoint.transport {
        LocalIpcTransport::UnixSocket => {
            #[cfg(unix)]
            {
                tokio::net::UnixStream::connect(endpoint.path())
                    .await
                    .map(LocalIpcStream::Unix)
            }
            #[cfg(not(unix))]
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Unix sockets are unavailable on this platform",
                ))
            }
        }
        LocalIpcTransport::NamedPipe => {
            #[cfg(windows)]
            {
                connect_named_pipe(endpoint.path())
                    .await
                    .map(LocalIpcStream::NamedPipeClient)
            }
            #[cfg(not(windows))]
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Named pipes are unavailable on this platform",
                ))
            }
        }
    }
}

pub fn bind(endpoint: &LocalIpcEndpoint) -> io::Result<LocalIpcListener> {
    endpoint.validate()?;
    match endpoint.transport {
        LocalIpcTransport::UnixSocket => {
            #[cfg(unix)]
            {
                tokio::net::UnixListener::bind(endpoint.path()).map(LocalIpcListener::Unix)
            }
            #[cfg(not(unix))]
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Unix sockets are unavailable on this platform",
                ))
            }
        }
        LocalIpcTransport::NamedPipe => {
            #[cfg(windows)]
            {
                Ok(LocalIpcListener::NamedPipe(NamedPipeListener {
                    path: endpoint.path().to_path_buf(),
                    pending: Some(create_named_pipe_instance(endpoint.path(), true)?),
                }))
            }
            #[cfg(not(windows))]
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Named pipes are unavailable on this platform",
                ))
            }
        }
    }
}

pub enum LocalIpcListener {
    #[cfg(unix)]
    Unix(tokio::net::UnixListener),
    #[cfg(windows)]
    NamedPipe(NamedPipeListener),
}

impl LocalIpcListener {
    pub async fn accept(&mut self) -> io::Result<LocalIpcStream> {
        match self {
            #[cfg(unix)]
            Self::Unix(listener) => listener
                .accept()
                .await
                .map(|(stream, _)| LocalIpcStream::Unix(stream)),
            #[cfg(windows)]
            Self::NamedPipe(listener) => listener.accept().await,
        }
    }
}

#[cfg(windows)]
pub struct NamedPipeListener {
    path: PathBuf,
    pending: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
}

#[cfg(windows)]
impl NamedPipeListener {
    async fn accept(&mut self) -> io::Result<LocalIpcStream> {
        let current = self.pending.take().ok_or_else(|| {
            io::Error::new(io::ErrorKind::BrokenPipe, "named pipe listener is closed")
        })?;
        // Keep a listening instance available while the accepted instance is
        // serving a client. This avoids a connection gap between accepts.
        self.pending = Some(create_named_pipe_instance(&self.path, false)?);
        current.connect().await?;
        Ok(LocalIpcStream::NamedPipeServer(current))
    }
}

#[cfg(windows)]
fn create_named_pipe_instance(
    path: &Path,
    first: bool,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::ServerOptions;
    ServerOptions::new().first_pipe_instance(first).create(path)
}

#[cfg(windows)]
async fn connect_named_pipe(
    path: &Path,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let mut retries = 0;
    loop {
        match ClientOptions::new().open(path) {
            Ok(client) => return Ok(client),
            Err(error)
                if error.raw_os_error() == Some(231)
                    || error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::PermissionDenied =>
            {
                retries += 1;
                if retries >= 100 {
                    return Err(error);
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

pub enum LocalIpcStream {
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
    #[cfg(windows)]
    NamedPipeServer(tokio::net::windows::named_pipe::NamedPipeServer),
    #[cfg(windows)]
    NamedPipeClient(tokio::net::windows::named_pipe::NamedPipeClient),
}

impl AsyncRead for LocalIpcStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Unix(stream) => Pin::new(stream).poll_read(cx, buf),
            #[cfg(windows)]
            Self::NamedPipeServer(stream) => Pin::new(stream).poll_read(cx, buf),
            #[cfg(windows)]
            Self::NamedPipeClient(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for LocalIpcStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Unix(stream) => Pin::new(stream).poll_write(cx, buf),
            #[cfg(windows)]
            Self::NamedPipeServer(stream) => Pin::new(stream).poll_write(cx, buf),
            #[cfg(windows)]
            Self::NamedPipeClient(stream) => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Unix(stream) => Pin::new(stream).poll_flush(cx),
            #[cfg(windows)]
            Self::NamedPipeServer(stream) => Pin::new(stream).poll_flush(cx),
            #[cfg(windows)]
            Self::NamedPipeClient(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Unix(stream) => Pin::new(stream).poll_shutdown(cx),
            #[cfg(windows)]
            Self::NamedPipeServer(stream) => Pin::new(stream).poll_shutdown(cx),
            #[cfg(windows)]
            Self::NamedPipeClient(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

impl fmt::Debug for LocalIpcStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(unix)]
            Self::Unix(_) => formatter.write_str("LocalIpcStream::Unix"),
            #[cfg(windows)]
            Self::NamedPipeServer(_) => formatter.write_str("LocalIpcStream::NamedPipeServer"),
            #[cfg(windows)]
            Self::NamedPipeClient(_) => formatter.write_str("LocalIpcStream::NamedPipeClient"),
        }
    }
}

fn platform_transport() -> LocalIpcTransport {
    if cfg!(windows) {
        LocalIpcTransport::NamedPipe
    } else {
        LocalIpcTransport::UnixSocket
    }
}

fn unix_socket_path_limit() -> usize {
    if cfg!(target_os = "macos") {
        103
    } else {
        107
    }
}

fn is_named_pipe_path(value: &str) -> bool {
    value.starts_with(r"\\.\pipe\")
        || value.starts_with(r"\\?\pipe\")
        || value.starts_with("//./pipe/")
}

fn validate_scope(scope: &str) -> io::Result<()> {
    if scope.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "local IPC scope must be non-empty",
        ));
    }
    Ok(())
}

fn validate_key(key: &str) -> io::Result<()> {
    if key.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "local IPC key must be non-empty",
        ));
    }
    Ok(())
}

fn validate_scope_name(scope_name: &str) -> io::Result<()> {
    if scope_name.trim().is_empty()
        || scope_name.contains('/')
        || scope_name.contains('\\')
        || scope_name.contains('\0')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "local IPC scope name must be a plain non-empty name",
        ));
    }
    Ok(())
}

fn validate_file_name(file_name: &str) -> io::Result<()> {
    if file_name.trim().is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains('\0')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "local IPC file name must be a plain non-empty name",
        ));
    }
    Ok(())
}

fn scope_name(scope: &str, key: &str, hash_length: usize) -> io::Result<String> {
    use sha2::{Digest, Sha256};
    if !(1..=64).contains(&hash_length) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "local IPC hash length must be between 1 and 64",
        ));
    }
    let hash = hex::encode(Sha256::digest(key.as_bytes()));
    Ok(format!("{scope}-{}", &hash[..hash_length]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn generated_and_explicit_named_pipe_detection_follows_node() {
        assert!(is_named_pipe_path(r"\\.\pipe\scope"));
        assert!(is_named_pipe_path(r"\\?\pipe\scope"));
        assert!(is_named_pipe_path("//./pipe/scope"));
        assert!(!is_named_pipe_path("/tmp/broker.sock"));
    }

    #[test]
    fn scope_names_use_a_sha256_prefix() {
        assert_eq!(
            scope_name("task-handoff-git-agent", "gitssh_test", 16).expect("scope"),
            "task-handoff-git-agent-248d80a576910e6c"
        );
    }

    #[test]
    fn explicit_scope_names_match_published_endpoint_layouts() {
        let endpoint = LocalIpcEndpoint::generated_with_scope_name(
            "task-handoff-git-proxy-4242",
            "broker.sock",
            None,
        )
        .expect("endpoint");
        if cfg!(windows) {
            assert_eq!(
                endpoint.path(),
                Path::new(r"\\.\pipe\task-handoff-git-proxy-4242")
            );
        } else {
            assert_eq!(
                endpoint.path(),
                temporary_root()
                    .join("task-handoff-git-proxy-4242")
                    .join("broker.sock")
            );
        }
    }

    #[test]
    fn explicit_scope_names_reject_path_separators() {
        assert!(
            LocalIpcEndpoint::generated_with_scope_name("../escape", "broker.sock", None).is_err()
        );
        assert!(
            LocalIpcEndpoint::generated_with_scope_name("scope", "../broker.sock", None).is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn endpoint_round_trips_requests() {
        let directory = tempfile::tempdir().expect("tempdir");
        let endpoint = LocalIpcEndpoint::in_directory(
            directory.path(),
            "task-handoff-test",
            "request",
            "broker.sock",
        )
        .expect("endpoint");
        endpoint.prepare().expect("prepare");
        let mut listener = bind(&endpoint).expect("bind");
        let accept = tokio::spawn(async move {
            let mut stream = listener.accept().await.expect("accept");
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.expect("read");
            stream.write_all(b"ok\n").await.expect("write");
            stream.shutdown().await.expect("shutdown");
            request
        });
        let mut client = connect(&endpoint).await.expect("connect");
        client.write_all(b"hello").await.expect("write request");
        client.shutdown().await.expect("shutdown request");
        let mut response = String::new();
        client.read_to_string(&mut response).await.expect("read");
        assert_eq!(response, "ok\n");
        assert_eq!(accept.await.expect("task"), b"hello");
        endpoint.cleanup().expect("cleanup");
        assert!(!endpoint.path().exists());
    }
}
