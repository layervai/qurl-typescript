package main

import (
	bytebuffer "bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/layervai/qurl-go/relayknock/internal/nhpwire"
)

// A local protocol peer, not a replacement for the sandbox enrollment gate.
func serve(agentKey string) error {
	agentPub, err := base64.StdEncoding.DecodeString(agentKey)
	if err != nil {
		return err
	}
	server, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return err
	}
	defer conn.Close()
	if err = json.NewEncoder(os.Stdout).Encode(map[string]any{"port": conn.LocalAddr().(*net.UDPAddr).Port, "key": base64.StdEncoding.EncodeToString(server.PublicKey().Bytes())}); err != nil {
		return err
	}
	cookie := make([]byte, 32)
	if _, err = rand.Read(cookie); err != nil {
		return err
	}
	generation := 1
	for {
		if err = conn.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
			return err
		}
		packet := make([]byte, 4096)
		n, addr, err := conn.ReadFromUDP(packet)
		if err != nil {
			return err
		}
		packet = packet[:n]
		kind, err := nhpwire.PacketType(packet)
		if err != nil {
			return err
		}
		var msg *nhpwire.Message
		if kind == 8 {
			msg, err = nhpwire.DecryptReknockMessage(server.Bytes(), agentPub, cookie, packet)
		} else if kind == 5 && binary.BigEndian.Uint16(packet[10:12]) == 4 {
			msg, err = nhpwire.DecryptHubLSTCookieProofMessage(server.Bytes(), agentPub, cookie, packet)
		} else {
			msg, err = nhpwire.DecryptMessage(server.Bytes(), agentPub, packet)
		}
		if err != nil {
			return err
		}
		var body map[string]any
		decoder := json.NewDecoder(bytebuffer.NewReader(msg.Body))
		decoder.UseNumber()
		if err = decoder.Decode(&body); err != nil {
			return err
		}
		data, _ := body["usrData"].(map[string]any)
		replyType := 2
		reply := map[string]any{"errCode": "0"}
		now := time.Now().UTC().Truncate(time.Second)
		if kind == 1 || (kind == 5 && data["query"] == "cell_assignment" && msg.Flags == 0) {
			replyType = 7
			reply = map[string]any{"trxId": msg.Counter, "cookie": base64.StdEncoding.EncodeToString(cookie)}
		} else if kind == 5 {
			replyType = 6
			list := map[string]any{"query": data["query"], "version": 1}
			if data["query"] == "cell_assignment" {
				if msg.Flags != 4 {
					return fmt.Errorf("assignment without proof")
				}
				if data["mode"] == "refresh" {
					generation = 2
				}
				cell := fmt.Sprintf("cell-%d", generation)
				list["mode"], list["agent_id"] = data["mode"], body["devId"]
				list["assignment"] = map[string]any{"cell_id": cell, "assignment_generation": generation, "endpoint_revision": 1, "lease_expires_at": now.Add(24 * time.Hour).Format(time.RFC3339), "nhp_udp_endpoint": map[string]any{"host": cell + ".layerv.ai", "port": 443, "server_public_key_b64": base64.StdEncoding.EncodeToString(server.PublicKey().Bytes())}}
				if data["mode"] == "enroll" {
					list["registration"] = map[string]any{"key_id": "key_123456789012", "key_kind": "bootstrap"}
					list["assignment_ticket"], list["assignment_ticket_expires_at"] = "qat1.test", now.Add(15*time.Minute).Format(time.RFC3339)
				} else if data["mode"] == "recover" {
					list["recovery_grant"] = "qrg1.test"
					list["recovery_grant_issued_at"], list["recovery_grant_expires_at"] = now.Format(time.RFC3339), now.Add(15*time.Minute).Format(time.RFC3339)
				}
			} else {
				list["device_api_key_id"] = "key_abcdefghijkl"
			}
			reply["list"] = list
		} else if kind == 13 {
			replyType = 14
			reply["aspId"] = "agent"
			reply["errMsg"] = ""
		} else if kind == 8 {
			reply["sessId"], reply["sessIssuedAtMillis"] = json.Number("18446744073709551615"), 12345
			reply["cellId"], reply["runId"], reply["runAttempt"] = fmt.Sprintf("cell-%d", generation), body["runId"], body["runAttempt"]
			reply["opnTime"], reply["agentAddr"] = 900, "1.2.3.4:1234"
			reply["acTokens"] = map[string]any{body["resId"].(string): "token"}
			reply["resHost"] = map[string]any{body["resId"].(string): "private.example"}
		} else if kind == 16 {
			for _, key := range []string{"cellId", "sessId", "sessIssuedAtMillis", "runId", "runAttempt"} {
				reply[key] = body[key]
			}
			reply["closeEventId"], reply["state"] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "closed"
		} else {
			return fmt.Errorf("unexpected type %d", kind)
		}
		raw, err := json.Marshal(reply)
		if err != nil {
			return err
		}
		ephemeral, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		encoded, err := nhpwire.BuildMessage(replyType, &nhpwire.Inputs{DeviceStaticPriv: server.Bytes(), ServerStaticPub: agentPub, EphemeralPriv: ephemeral.Bytes(), TimestampNanos: uint64(time.Now().UnixNano()), Counter: msg.Counter, Preamble: 12345, Body: raw})
		if err != nil {
			return err
		}
		if _, err = conn.WriteToUDP(encoded, addr); err != nil {
			return err
		}
	}
}
