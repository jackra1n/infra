#!/bin/bash

for pid in /proc/[0-9]*; do
    p=$(basename $pid)
    printf "%4d FDs for PID %6d; command=%s\n" $(ls $pid/fd | wc -l) $p "$(ps -p $p -o comm=)"
done | sort -nr | head -10
