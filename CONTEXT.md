# HushOS

HushOS is an end-to-end encrypted productivity suite organized around user accounts and workspaces. Drive, with families, is built: files are encrypted on the device, and the server holds ciphertext.

## Language

**Account**:
A user's identity in HushOS, independent of the workspaces they can access.

**Workspace**:
A collection of HushOS content with its own membership and access permissions. A personal workspace belongs to one user; a shared workspace has multiple members.

**Account key**:
A user's private, long-lived encryption root across HushOS. Access to a workspace never requires disclosing a member's account key.
_Avoid_: Main key, master key, root folder key

**Workspace key**:
An encryption key belonging to a workspace, independent of every member's account key. Workspace key access is distinct from permission to perform an action in that workspace.

**Wrapping key**:
A purpose-specific key that protects another key in an encrypted envelope.

**Key envelope**:
An encrypted copy of a key together with the information needed to authenticate and unlock that copy.

**Session**:
An authenticated account's access to HushOS from a client. An authenticated session and an unlocked account key are distinct states.
