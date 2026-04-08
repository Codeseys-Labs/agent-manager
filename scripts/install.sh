#!/bin/bash
# Install agent-manager (am) — downloads the right binary for your platform
set -e

REPO="baladithyab/agent-manager"
VERSION="${1:-latest}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Detect OS and arch
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)        ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

ARTIFACT="am-${OS}-${ARCH}"

# Windows detection (MSYS/Git Bash/WSL)
if [[ "$OS" == mingw* ]] || [[ "$OS" == msys* ]] || [[ "$OS" == cygwin* ]]; then
  OS="windows"
  ARTIFACT="am-windows-x64.exe"
fi

# Build download URL
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ARTIFACT"
else
  URL="https://github.com/$REPO/releases/download/v$VERSION/$ARTIFACT"
fi

echo "Downloading $ARTIFACT..."
curl -fsSL "$URL" -o "$INSTALL_DIR/am"
chmod +x "$INSTALL_DIR/am"
echo "Installed am $("$INSTALL_DIR/am" version 2>/dev/null || echo "$VERSION")"
