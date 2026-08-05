package main

import _ "embed"

//go:embed assets/cloudflared-darwin-amd64
var embeddedCloudflared []byte

const embeddedCloudflaredExeSuffix = ""
