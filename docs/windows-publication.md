# Windows no-replace publication

`runSafeTransaction` creates its owner-only private stage as one immediate child
of `dirname(destinationPath)` before output bytes are written. The native stage
capability retains non-reparse handles and `FILE_ID_INFO` for that stage and its
effective destination parent. Creation fails when either identity is unavailable.

The still-open verified stage-file handle names the verified object. Immediately
before publication the native boundary reopens the effective destination parent
and stage directory without following reparses, compares both identities with the
captured capability, then reads `FileIdInfo` for the parent, stage directory, and
stage file. All three `VolumeSerialNumber` values must be present and equal. A
changed identity, missing identity, or unequal volume is typed non-success before
any link call. These path resolutions are freshness prerequisites, never success
authority.

The destination must be an absolute file path with neither NUL nor alternate data
stream syntax. Once the proof passes, exactly one
`CreateHardLinkW(destinationPath, stagePath, NULL)` is issued. Its success alone
is publication authority: it atomically creates a new directory entry for the
verified staged file. Existing destinations map to collision and remain untouched.
All other results are unsupported or bounded `link:<win32-code>` failures; an
unexpected `ERROR_NOT_SAME_DEVICE` never retries or falls back.

No empty-file reservation/replacement, replacement-capable operation, copy/delete
fallback, undocumented NT information class, or rename retry is permitted. The
post-commit path removes only the private stage link and directory. If that cleanup
is uncertain after link success, the result stays successful and reports only the
bounded private-stage residue.

## Host N-API binding

Windows resolves an imported symbol against a module **named at link time**. The
addon is loaded by whatever process hosts it, and in a packaged Electron
application that host is the application executable — its name varies per
application and is not `node.exe`. An addon that declares an import from the
literal name `node.exe` therefore makes the loader search for that file and map a
**second, complete Node runtime** into the process. The addon then calls into the
wrong runtime: handles minted by the real host are decompressed against the other
V8 pointer-compression cage, and the first N-API call faults with an access
violation during module registration, before any publication work runs.

`publication.node` consequently declares **no dependency on its host at all** —
neither a static import nor a delay-load descriptor. `publication_bind_host`
resolves the fixed N-API surface once, at the top of module registration, against
the module that is already hosting the addon. Nothing is loaded: `GetModuleHandleW`
returns a handle only for a module the loader has already mapped, `NULL` asks for
the running process image, and `libnode.dll` is probed only for a Node built as a
shared library and used only when it actually provides the surface. If any entry
point is missing the addon registers no properties rather than calling into an
unverified surface.

Two gates hold this shape. `scripts/audit_native_source.cjs` confines the
resolution: `GetProcAddress` may appear only inside `publication_bind_host`, the
module handle may come only from `NULL` or `libnode.dll`, and the resolvable names
are a fixed allowlist; `dlopen`, `dlsym`, `LoadLibrary*`, `GetModuleHandleA` and
`GetModuleHandleEx*` remain forbidden outright.
`scripts/check_windows_host_independence.cjs` reads the PE import and delay-import
data directories of every Windows prebuild — from any host, not only Windows — and
fails if either names the host executable.
