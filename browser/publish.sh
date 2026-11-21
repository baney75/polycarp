#!/bin/bash

# Exit on error
set -e

echo "🔨 Building sitegeist..."
npm run build

echo "📦 Creating zip archive..."
ZIP_NAME="sitegeist-latest.zip"

# Remove old zip if it exists
rm -f "${ZIP_NAME}"

# Create a temporary directory with the desired folder name
TEMP_DIR=$(mktemp -d)
cp -r dist-chrome "${TEMP_DIR}/sitegeist"

# Remove .map files
find "${TEMP_DIR}/sitegeist" -name "*.map" -type f -delete

# Create zip with sitegeist as the root folder
cd "${TEMP_DIR}"
zip -r "${ZIP_NAME}" sitegeist
mv "${ZIP_NAME}" "${OLDPWD}/"
cd "${OLDPWD}"

# Clean up temp directory
rm -rf "${TEMP_DIR}"

echo "📝 Creating version.json..."
# Extract version from dist-chrome manifest.json
VERSION=$(node -p "require('./dist-chrome/manifest.json').version")
echo "{\"version\":\"${VERSION}\"}" > version.json

echo "📤 Uploading to server..."
# Upload to sitegeist.ai uploads directory
SERVER="slayer.marioslab.io"
REMOTE_PATH="/home/badlogic/sitegeist.ai/uploads"

# Ensure uploads directory exists on server
ssh "${SERVER}" "mkdir -p ${REMOTE_PATH}"

# Upload files
scp "${ZIP_NAME}" "${SERVER}:${REMOTE_PATH}/"
scp "version.json" "${SERVER}:${REMOTE_PATH}/"

echo "✅ Done! Version ${VERSION} published to sitegeist.ai/uploads/"
