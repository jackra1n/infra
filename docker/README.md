For traefik to be able to forward requests to the containers, they need to be on the same network. Create a network called proxy:

```bash
docker network create proxy
```

The compose file of traefik also needs some configuration first before it can run properly.
You need to set the `CLOUDFLARE_EMAIL` and `CLOUDFLARE_API_KEY` environment variables as well as replace the `local.example.com` with your domain in the label section.

Uptime Kuma and Adguard home run on a Raspberry Pi 4 with a PoE hat and script from https://github.com/jackra1n/RustBerry-PoE-Monitor

