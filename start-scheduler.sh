#!/bin/bash
cd ~/work/git-deploy-schedule
source venv/bin/activate
exec python main_web.py --port 5001
