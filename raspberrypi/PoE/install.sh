#!/bin/bash
# 2022-01-01 Charles Godwin
#  Derived from https://www.waveshare.com/wiki/PoE_HAT_(B)
# enable i2c interface if necessary
# Read the following for details
# https://gist.github.com/CharlesGodwin/adda3532c070f6f6c735927a5d6e8555#file-waveshare-poe-hat-md
#
IS_I2C=`sudo raspi-config nonint get_i2c`
[ $IS_I2C -ne 0 ]&&sudo raspi-config nonint do_i2c 0
# install required packages
sudo apt update
sudo apt install -y python3-pip python3-pil libatlas-base-dev
sudo pip3 install RPi.GPIO smbus numpy
# cleanout artifacts if necesary
[ -d ~/PoE_HAT_B_code ] && rm -rf ~/PoE_HAT_B_code
[ -f ~/PoE_HAT_B_code.7z ] && rm -rf ~/PoE_HAT_B_code.7z
# install Waveshare libraries and examples
wget https://www.waveshare.com/w/upload/8/8b/PoE_HAT_B_code.zip
unzip -o  PoE_HAT_B_code.zip -d .
# move required parts to ~/.poe-hat directory
[ -d ~/.poe-hat ] && rm -rf ~/.poe-hat
mkdir -p ~/.poe-hat
mv PoE_HAT_B_code/python/examples/main.py ~/.poe-hat/
mv PoE_HAT_B_code/python/lib/waveshare_POE_HAT_B ~/.poe-hat/
mv PoE_HAT_B_code/python/readme_EN.txt ~/.poe-hat/PoE_HAT_B_readme.txt
# cleanup
rm PoE_HAT_B_code.zip
rm -rf PoE_HAT_B_code
rm -f $0
#
# define and enable service
#
PYTHON=`which python3 |head -n1`
cat <<EOF >poe-hat.service
[Unit]
Description=Waveshare Poe Hat B
After=network.target
[Service]
Environment=systemd=true
ExecStart=${PYTHON} ${HOME}/.poe-hat/main.py
Restart=always
RestartSec=30
[Install]
WantedBy=multi-user.target
EOF
sudo mv -f poe-hat.service /etc/systemd/system
sudo systemctl daemon-reload
sudo systemctl enable poe-hat.service --now
sudo systemctl status poe-hat.service --no-pager