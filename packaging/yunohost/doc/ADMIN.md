## Service and logs

The service is named after the YunoHost app instance. View its status and
application log in the YunoHost admin interface, or use:

```bash
sudo yunohost service status seerrng
sudo yunohost service log seerrng
sudo journalctl -u seerrng
```

The application also rotates its logs under
`/home/yunohost.app/seerrng/logs/`. Additional instances use a suffixed app
name and a separate data directory.

## Backups and upgrades

Use YunoHost's normal app backup, restore, and upgrade commands. The package
updates from SeerrNG's published Linux release archives and verifies each
download against its pinned SHA-256 checksum. YunoHost provisions Node.js 24
for the service.

The SeerrNG service binds to localhost behind YunoHost's Nginx proxy. Keep the
allocated app port private. Do not expose it directly to the network.
