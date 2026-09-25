# Format Admission Criteria

Every format `exifcleaner-node` admits — WebP today, PNG and JPEG in Phases 56 and 57 — must clear
the same eight tiered evidence items before it registers a handler. This document lists what the
shared qualification kit already provides for each item, and what a format must supply on top of
it. `tests/format_admission_doc.test.ts` enforces the order, the presence of both lines in every
item, and that every backticked repository path named below actually exists, so this document
cannot drift from the kit it describes (KIT-06, D-23).

## 1. Spec note

A short prose note: the format's structure grammar, which parts carry identifying metadata, and
which parts a sanitize must preserve untouched.

Kit provides: this document's own per-item template, so every format's spec note lands in the same
place with the same two obligations spelled out.

Format supplies: the grammar, the identifying parts, and the preserved parts, written in its own
words in this section when the format is admitted.
