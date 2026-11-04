// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* The pairing identity: an RSA-2048 key and a self-signed X.509 cert, as
 * moonlight-embedded's mkcert.c makes them with OpenSSL (CN "NVIDIA
 * GameStream Client", SHA-256, 20 years). The host binds the pairing to this
 * cert, so pairing once (on the Mac) and copying DIR to the car is enough.
 * Node 22 (the control plane) loads the PEMs; it cannot create a cert. */
#include <errno.h>
#include <fcntl.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/error.h>
#include <mbedtls/pk.h>
#include <mbedtls/platform_util.h>
#include <mbedtls/rsa.h>
#include <mbedtls/x509_crt.h>
#include <psa/crypto.h>
#include <string.h>
#include <unistd.h>
#include <string>

namespace {

bool write_file(const std::string &path, const unsigned char *p, std::string *err)
{
    const std::string tmp = path + ".tmp";
    int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) return *err = tmp + ": " + strerror(errno), false;
    const size_t n = strlen((const char *)p);
    const bool ok = write(fd, p, n) == (ssize_t)n && fsync(fd) == 0;
    close(fd);
    if (!ok || rename(tmp.c_str(), path.c_str()) != 0) return *err = path + ": write failed", unlink(tmp.c_str()), false;
    return true;
}

}  // namespace

int mkcert(const char *dir, std::string *err)
{
    const std::string key_path = std::string(dir) + "/key.pem", crt_path = std::string(dir) + "/cert.pem";
    if (access(key_path.c_str(), F_OK) == 0) return *err = key_path + " exists: refusing to replace a paired identity", -1;
    if (psa_crypto_init() != PSA_SUCCESS) return *err = "psa_crypto_init failed", -1;
    mbedtls_entropy_context ent;
    mbedtls_ctr_drbg_context drbg;
    mbedtls_pk_context pk;
    mbedtls_x509write_cert crt;
    mbedtls_entropy_init(&ent);
    mbedtls_ctr_drbg_init(&drbg);
    mbedtls_pk_init(&pk);
    mbedtls_x509write_crt_init(&crt);
    static unsigned char pem[16384];
    static const unsigned char serial[] = {1};
    static const char pers[] = "mgu-moonlight-mkcert";
    int rc = mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &ent, (const unsigned char *)pers, sizeof pers - 1);
    if (!rc) rc = mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA));
    if (!rc) rc = mbedtls_rsa_gen_key(mbedtls_pk_rsa(pk), mbedtls_ctr_drbg_random, &drbg, 2048, 65537);
    if (!rc) {
        mbedtls_x509write_crt_set_version(&crt, MBEDTLS_X509_CRT_VERSION_3);
        mbedtls_x509write_crt_set_md_alg(&crt, MBEDTLS_MD_SHA256);
        mbedtls_x509write_crt_set_subject_key(&crt, &pk);
        mbedtls_x509write_crt_set_issuer_key(&crt, &pk);
        rc = mbedtls_x509write_crt_set_serial_raw(&crt, (unsigned char *)serial, sizeof serial);
    }
    if (!rc) rc = mbedtls_x509write_crt_set_subject_name(&crt, "CN=NVIDIA GameStream Client");
    if (!rc) rc = mbedtls_x509write_crt_set_issuer_name(&crt, "CN=NVIDIA GameStream Client");
    if (!rc) rc = mbedtls_x509write_crt_set_validity(&crt, "20260101000000", "20460101000000");
    bool ok = false;
    if (!rc && !(rc = mbedtls_pk_write_key_pem(&pk, pem, sizeof pem)) && write_file(key_path, pem, err) &&
        !(rc = mbedtls_x509write_crt_pem(&crt, pem, sizeof pem, mbedtls_ctr_drbg_random, &drbg)) &&
        write_file(crt_path, pem, err))
        ok = true;
    if (rc) {
        char b[128];
        mbedtls_strerror(rc, b, sizeof b);
        *err = std::string("mbedtls: ") + b;
    }
    if (!ok) unlink(key_path.c_str());
    mbedtls_platform_zeroize(pem, sizeof pem);   /* the private key was in here */
    mbedtls_x509write_crt_free(&crt);
    mbedtls_pk_free(&pk);
    mbedtls_ctr_drbg_free(&drbg);
    mbedtls_entropy_free(&ent);
    return ok ? 0 : -1;
}
