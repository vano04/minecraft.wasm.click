// SPDX-License-Identifier: GPL-3.0-only
package main

import "golang.org/x/sys/windows"

func init() {
	var mode uint32
	if windows.GetConsoleMode(windows.Stdout, &mode) == nil {
		_ = windows.SetConsoleMode(windows.Stdout, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING)
	}
}
