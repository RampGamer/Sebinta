package main

// version is the release tag this binary was built from, stamped at build
// time:
//
//	go build -ldflags "-X main.version=$(git describe --tags --abbrev=0)" .
//
// A plain `go build` leaves it at "dev", which the landing page treats as
// "unknown" and so never shows the update notice for.
var version = "dev"
