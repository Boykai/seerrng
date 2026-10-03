# SeerrNG for YunoHost

This YunoHost package installs SeerrNG's prebuilt Linux release archives. It
supports `amd64` and `arm64`, uses YunoHost's Node.js 24 runtime, and stores
persistent application data in the YunoHost app data directory.

The installable package is maintained in the dedicated
[`seerrng_ynh`](https://github.com/YunoHost-Apps/seerrng_ynh) repository, whose root
layout is compatible with YunoHost's package tools:

```bash
sudo yunohost app install https://github.com/YunoHost-Apps/seerrng_ynh --debug
```

Stable SeerrNG releases update the package manifest with the matching release
version, Linux archive URLs, and verified checksums for both supported
architectures. YunoHost's `latest_github_release` source updater remains enabled
as a fallback; administrators install package updates through the normal
YunoHost app upgrade flow.

The app requires a dedicated domain root because SeerrNG does not support URL
subpaths. The package does not integrate with YunoHost LDAP or portal SSO.
See [`doc/`](doc/) for install, admin, and service details.
