#!/bin/bash

# Make users and group
sudo useradd sonarr -u 13001
sudo useradd radarr -u 13002
sudo useradd prowlarr -u 13003
sudo useradd bazarr -u 13004
sudo useradd qbittorrent -u 13005
sudo useradd plex -u 13006
sudo useradd overseerr -u 13007
sudo groupadd mediacenter -g 13000

# Add users to group
sudo usermod -a -G mediacenter sonarr
sudo usermod -a -G mediacenter radarr
sudo usermod -a -G mediacenter prowlarr
sudo usermod -a -G mediacenter bazarr
sudo usermod -a -G mediacenter qbittorrent
sudo usermod -a -G mediacenter plex
sudo usermod -a -G mediacenter overseerr

# Create directories
sudo mkdir -pv config/{sonarr,radarr,prowlarr,bazarr,qbittorrent,plex,overseerr}-config
sudo mkdir -pv data/{sonarr,radarr,prowlarr,bazarr,qbittorrent,plex}-data

# Set permissions
sudo chmod -R 775 data/
sudo chown -R $(id -u):mediacenter data/
sudo chown -R sonarr:mediacenter config/sonarr-config
sudo chown -R radarr:mediacenter config/radarr-config
sudo chown -R prowlarr:mediacenter config/prowlarr-config
sudo chown -R bazarr:mediacenter config/bazarr-config
sudo chown -R qbittorrent:mediacenter config/qbittorrent-config
sudo chown -R plex:mediacenter config/plex-config
sudo chown -R overseerr:mediacenter config/overseerr-config
