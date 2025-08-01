# 🏠 Homelab

# 🏠 Homelab

This repository contains a collection of my personal homelab scripts and Docker Compose files. Most of these setups should work with minimal changes, but some require a `.env` file with specific variables. In those cases, you should find a `.env.example` file in the service's directory detailing what's needed.

On my server, I use a global `DOCKER_DATA_DIR` environment variable to define the base directory for all Docker container data.


## 🤖 Automation

The Docker Compose files are pinned to specific image versions. I use Renovate bot to automatically check for updates. When a new version of a Docker image is available, Renovate opens a pull request.

Once a pull request is merged into the `main` branch, a webhook notifies my home Komodo instance. This triggers a deployment script that pulls the latest repository changes and redeploys the affected Docker stacks.

## ⚠️ Disclaimer

Feel free to use anything you find here. However, I can't offer any guarantees that it will work for your specific setup.
