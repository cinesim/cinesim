# Cloud originals

Cinesim offers separate, immutable **Cloud** and **Local** project kinds. The Home page lists Cloud
above Local and explains the distinction without blocking signed-out use. Local projects never
require an account. Creating or opening a cloud project requires the owning account, and every
supported original imported into that project is queued for private cloud storage. Project kinds
cannot be converted or mixed.

The canonical project remains local, portable, and inspectable; a cloud-backed asset stores only an opaque
`cloud_asset_…` locator. Credentials, bucket names, object keys, upload URLs, and account cookies
never enter canonical project files or the renderer.

## Architecture

- One private Cloudflare R2 bucket stores originals for all accounts.
- PostgreSQL is the control plane for ownership, quota, projects, assets, multipart uploads, and
  completed parts.
- Object keys use random per-account namespaces plus opaque cloud project and asset IDs. Local
  project and asset IDs are metadata, not authorization boundaries.
- Every cloud API route resolves the Better Auth session and scopes database reads to that user.
- Electron main performs bounded file reads and direct signed R2 requests. The sandboxed renderer
  can only retry, cancel, and inspect typed transfer snapshots through preload IPC.
- The `cinesim-media://` protocol serves local proxies first. If an operation explicitly needs a
  cloud original, Electron main obtains a five-minute download URL and streams ranges without
  revealing the URL to the renderer.

## Upload and offload lifecycle

1. Import into a cloud project commits the local asset and automatically queues its original for
   the signed-in account. Opening a cloud project also reconciles eligible originals that were
   waiting while offline. Local-project imports never enter the cloud queue.
2. Cinesim queues thumbnail, filmstrip, and waveform work first. The thumbnail is published as soon
   as it is encoded; upload preparation waits until the applicable perception artifacts are ready
   or have reached a non-blocking failed state.
3. Cinesim queues the configured local edit proxy, fingerprints the source edges, and streams a
   full SHA-256 calculation.
4. The API reserves the source byte count under an account row lock before it creates a private R2
   multipart upload.
5. Electron uploads 64 MiB parts with at most three in flight. It records every R2 ETag with the
   API and persists resumable state in the app user-data directory. Media is never loaded into
   memory as one complete file.
6. The API completes the multipart upload, verifies the object size, and atomically moves reserved
   bytes to used bytes.
7. Only after both the cloud original and local proxy are ready does Cinesim commit
   `asset.setSource`. The file originally selected by the user is never moved, renamed, or deleted.

Normal local imports reference the selected filesystem path in place. macOS may export selections
from Apple Photos through its temporary directory; for those selections only, Cinesim first makes a
verified managed copy at `.video/originals/<asset-id>`. A local project keeps that path as its source
because the picker export can disappear. A cloud project uses the copy as resumable upload staging
and removes only that Cinesim-owned copy after upload and proxy finalization. The Photos export
itself is never modified.

A cloud-backed asset offers **Keep downloaded** in its Media Bin context menu. This streams a
verified disposable copy to `.video/originals/<asset-id>` and changes the action to **Remove
download**. The canonical source remains cloud-backed, proxy editing remains the default, and cloud
original reads prefer the downloaded copy while it exists. Removing a download only deletes this
contained `.video/originals/` copy; it never touches the path used during import.

Transfers are scoped by account, project directory, and asset ID. An unavailable service produces
**Waiting for cloud** while leaving the original in place. Interrupted `preparing`, `uploading`, or
`waiting-for-proxy` work reopens as **Paused**. Retry first
checks source size, modification time, edge hash, and full SHA-256, then asks the server which parts
already exist. Completed cloud uploads can therefore resume proxy finalization without reuploading.

Removing a cloud asset from a project moves its original to cloud Trash. Trashed objects still
count toward quota, can be restored in Settings, and are eligible for permanent deletion after 30
days. Expired multipart uploads and expired Trash are reconciled whenever account usage is read.

## Proxy policy

The performance-driven adaptive policy has been removed. Each project now has explicit settings in
`.cinesim/settings.toml`:

- **Automatic** or **Manual** generation.
- **Space saver**: 960-pixel long edge, 30 fps cap, low quality.
- **Balanced**: 1280-pixel long edge, 60 fps cap, medium quality (the default).
- **High quality**: 1920-pixel long edge, 60 fps cap, high quality.
- **Custom** long edge, frame-rate cap, and quality for advanced users.

Video proxies include their audio track, and audio-only sources receive an MP4/AAC edit
representation. Playback reports **Proxy** or **Original** in the viewer header. A cloud original
always queues a missing proxy even when the project is set to Manual, and cloud-backed proxies are
not candidates for automatic cache eviction.

## Development setup

Create a private R2 bucket and an R2 API token limited to object read and write for that bucket.
Copy `apps/api/.env.example` to the ignored `apps/api/.env.local` and set:

```dotenv
CLOUDFLARE_R2_ACCOUNT_ID=...
CLOUDFLARE_R2_BUCKET=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CINESIM_CLOUD_INCLUDED_BYTES=10737418240
CINESIM_CLOUD_ADDON_OPTIONS_BYTES=0,53687091200,214748364800
```

The add-on list is an operator-controlled set of account quota choices. `0` means included storage
only. A user can select another configured allowance in Settings, but cannot reduce the allowance
below used plus reserved bytes. Production billing can grant a narrower list without changing the
storage protocol.

Apply the committed database migration before testing:

```bash
pnpm --filter @cinesim/api db:migrate
```

No public bucket URL or R2 CORS policy is required because transfers run from Electron main. Keep
the bucket private and never put R2 credentials into desktop build-time variables.

## End-to-end checklist

1. Start signed out. Confirm local create/open/edit and local agents work, while a cloud create asks
   for sign-in inline rather than replacing the Home screen.
2. Sign in, confirm Cloud and Local remain separate collapsible Home sections, then confirm **Cloud
   storage** is present and offline reopening retains the cached
   account identity.
3. Import a video with audio and confirm upload starts without a per-asset prompt. Confirm card
   progress survives closing and reopening the app as a paused, retryable transfer.
4. After completion, confirm the card says **Cloud original**, the viewer says **Proxy**, the
   originally selected file remains untouched, and seeking still works.
5. Delete the `.video/` proxy while online, reopen the project, and confirm the required proxy is
   regenerated from signed cloud range requests.
6. Verify usage totals at account, project, and asset levels; test quota rejection and a configured
   add-on allowance.
7. Remove a cloud asset from the project, then verify Trash, Restore, and permanent delete behavior
   in Settings.
8. Repeat a proxy-backed edit offline. The existing proxy must remain usable; operations requiring
   original bytes should report that cloud storage is unavailable without corrupting the project.
9. Choose **Keep downloaded**, confirm `.video/originals/<asset-id>` is used offline, then choose
   **Remove download** and confirm only that disposable copy is removed.
10. Import ordinary filesystem media into a local project and confirm it remains an in-place
    reference. Import from Apple Photos and confirm the local project instead references its managed
    `.video/originals/<asset-id>` copy.

Still-image import is not currently exposed by the desktop media picker; cloud offload therefore
accepts the editor's supported video and audio originals.
