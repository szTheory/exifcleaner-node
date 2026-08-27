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
