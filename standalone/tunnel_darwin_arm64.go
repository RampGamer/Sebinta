package main

import _ "embed"

//go:embed assets/cloudflared-darwin-arm64
var embeddedCloudflared []byte

const embeddedCloudflaredExeSuffix = ""
