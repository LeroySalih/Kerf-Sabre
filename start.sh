#!/usr/bin/env bash
# Start the Kerf Sabre Server, Editor and laser connector on this PC (Mac/Linux). See: ./start.sh --help
cd "$(dirname "$0")" || exit 1
for py in python3.13 python3.12 python3.11 python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    exec "$py" start.py "$@"
  fi
done
echo "Python 3.11 or newer is needed. Install it from https://www.python.org/downloads/ and run this again."
exit 1
