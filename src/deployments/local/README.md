# Local — the default target

SQLite, an encrypted file, and a directory. No network, no account, no
credential beyond the two encryption keys, and everything under one workspace
root that a `cp -R` backs up.

There is no `target.ts` here: the local branches of `../target.ts` are three
lines each and inlining them keeps the whole mapping readable in one place. A
deployment earns a folder when it has machinery of its own — `../gcp/` has a
Dockerfile, a build config, and a rollout driver.

What lives on disk, and where, is `#profile`'s `workspace.ts`.
