// This test-only program is compiled against the exact Go revision in parity-manifest.json.
package main

import (
	"context"
	"crypto/ecdh"
	"encoding/json"
	"fmt"
	"github.com/layervai/qurl-go/qurl"
	"github.com/layervai/qurl-go/relayknock"
	"github.com/layervai/qurl-go/relayknock/internal/nhpwire"
	"os"
)

// Plaintext wrapping is only for format interoperability tests, never production.
type testWrapper struct{}

func (testWrapper) WrapKey(_ context.Context, key []byte, _ qurl.AgentStateKeyBinding) (qurl.WrappedAgentStateKey, error) {
	return qurl.WrappedAgentStateKey{Version: 1, Ciphertext: append([]byte(nil), key...), Metadata: json.RawMessage(`{"z":"<&>","2":1.00,"10":2e0,"a":"cross-language"}`)}, nil
}
func (testWrapper) UnwrapKey(_ context.Context, key qurl.WrappedAgentStateKey, _ qurl.AgentStateKeyBinding) ([]byte, error) {
	return append([]byte(nil), key.Ciphertext...), nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) == 3 && os.Args[1] == "serve" {
		return serve(os.Args[2])
	}
	ctx := context.Background()
	if len(os.Args) == 3 {
		store, err := qurl.NewSealedFileAgentState(os.Args[2], "parity-test", testWrapper{})
		if err != nil {
			return err
		}
		defer store.Close()
		state, err := store.LoadAgentState(ctx)
		if err != nil {
			return err
		}
		if os.Args[1] == "roundtrip" {
			if err = store.SaveAgentState(ctx, state); err != nil {
				return err
			}
		}
		return json.NewEncoder(os.Stdout).Encode(state)
	}
	server, err := ecdh.X25519().NewPrivateKey(bytes(4))
	if err != nil {
		return err
	}
	packets := map[int][]byte{}
	for _, kind := range []int{1, 5, 8, 12, 13, 16, 105} {
		inp := &relayknock.KnockInputs{DeviceStaticPriv: bytes(9), ServerStaticPub: server.PublicKey().Bytes(), EphemeralPriv: bytes(7), TimestampNanos: 2000000000000000000, Counter: 18446744073709551615, Preamble: 12345, Body: []byte(`{"devId":"parity-agent"}`)}
		if kind == 8 || kind == 105 {
			inp.Cookie = bytes(6)
		}
		if kind == 105 {
			packets[kind], err = nhpwire.BuildHubLSTCookieProof(inp.WireInputs())
		} else {
			packets[kind], err = relayknock.BuildMessage(kind, inp)
		}
		if err != nil {
			return err
		}
	}
	return json.NewEncoder(os.Stdout).Encode(packets)
}
func bytes(value byte) []byte {
	result := make([]byte, 32)
	for i := range result {
		result[i] = value
	}
	return result
}
