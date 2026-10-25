#!/usr/bin/env bash
# Build step of the CivicAI API on Render (render.yaml: rootDir backend, buildCommand ./build.sh).
#
#   1. install the Python dependencies (+ the deep-learning stack when MODEL_MODE=production)
#   2. collect the static files (served by WhiteNoise from backend/staticfiles)
#   3. apply the database migrations (DATABASE_URL)
#   4. install / complete the reference data (departments, categories, AI configuration, risk zones) without
#      overwriting rows an administrator has edited; creates the first administrator when CIVICAI_ADMIN_EMAIL and
#      CIVICAI_ADMIN_PASSWORD are set in the environment
#   5. MODEL_MODE=production only: download and cache the AI model weights now instead of on the first request
set -o errexit
set -o nounset
set -o pipefail

python -m pip install --upgrade pip
pip install -r requirements.txt
if [ "${MODEL_MODE:-demo}" = "production" ]; then
  pip install -r requirements-ml.txt
fi

python manage.py collectstatic --noinput
python manage.py migrate --noinput
python manage.py init_civicai --keep-existing

if [ "${MODEL_MODE:-demo}" = "production" ]; then
  python manage.py warmup_ai
fi
