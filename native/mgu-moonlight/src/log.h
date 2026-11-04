// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#ifndef MGU_LOG_H
#define MGU_LOG_H
/* one timestamped line to the log (main.cpp) */
void log_line(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
#endif
