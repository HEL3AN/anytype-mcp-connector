// derive-account-key converts an Anytype login key (12-word mnemonic) into the
// base64 account key accepted by `anytype auth login --account-key`.
//
// The derivation mirrors anytype-heart's WalletCreate:
//
//	DeriveKeys(0).MasterNode -> MarshalBinary -> base64.StdEncoding
//
// Run it offline on your own machine. The mnemonic is read from the terminal
// without echo and is never written anywhere.
package main

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"github.com/anyproto/any-sync/util/crypto"
	"golang.org/x/term"
)

func main() {
	phrase, err := readPhrase()
	if err != nil {
		fail(err)
	}

	words := strings.Fields(strings.ToLower(phrase))
	if len(words) != 12 {
		fail(fmt.Errorf("expected 12 words, got %d", len(words)))
	}

	res, err := crypto.Mnemonic(strings.Join(words, " ")).DeriveKeys(0)
	if err != nil {
		fail(fmt.Errorf("derive keys: %w", err))
	}

	node, err := res.MasterNode.MarshalBinary()
	if err != nil {
		fail(fmt.Errorf("marshal master node: %w", err))
	}

	// Account ID lets you verify the key belongs to your account:
	// compare it with the identity shown in Anytype (Settings → profile).
	fmt.Fprintln(os.Stderr, "Account ID:", res.Identity.GetPublic().Account())
	fmt.Fprintln(os.Stderr, "Account key (keep it secret, it grants full access):")
	fmt.Println(base64.StdEncoding.EncodeToString(node))
}

func readPhrase() (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "Enter your 12-word login key (input hidden): ")
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		return string(b), err
	}
	return bufio.NewReader(os.Stdin).ReadString('\n')
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
