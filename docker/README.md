For traefik to be able to forward requests to the containers, they need to be on the same network. Create a network called proxy:

```bash
docker network create proxy
```


