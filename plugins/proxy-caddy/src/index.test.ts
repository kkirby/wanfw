import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, renderTask } from "./index.js";

describe("proxy-caddy plugin (§8.4/§8.5)", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("proxy-caddy");
  });

  it("renders a single-service Caddyfile with tls internal and a :443/:80 catch-all", () => {
    const result = renderTask({
      routes: [{ serviceId: "kavita", hostname: "kavita.example.tld", backendPort: 5000, backendProtocol: "http" }],
    });

    expect(result.filename).toBe("Caddyfile");
    expect(result.reloadCmd).toEqual(["caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
    expect(result.content).toMatchInlineSnapshot(`
      "kavita.example.tld {
      	tls internal
      	reverse_proxy http://wanfw_kavita:5000
      }

      :443 {
      	tls internal
      	respond 404
      }

      :80 {
      	respond 404
      }
      "
    `);
  });

  it("renders a multi-service Caddyfile with one site block per route, in the given order, plus the catch-all", () => {
    const result = renderTask({
      routes: [
        { serviceId: "jellyfin", hostname: "jellyfin.example.tld", backendPort: 8096, backendProtocol: "http" },
        { serviceId: "kavita", hostname: "kavita.example.tld", backendPort: 5000, backendProtocol: "http" },
      ],
    });

    expect(result.content).toMatchInlineSnapshot(`
      "jellyfin.example.tld {
      	tls internal
      	reverse_proxy http://wanfw_jellyfin:8096
      }

      kavita.example.tld {
      	tls internal
      	reverse_proxy http://wanfw_kavita:5000
      }

      :443 {
      	tls internal
      	respond 404
      }

      :80 {
      	respond 404
      }
      "
    `);
    expect(result.content.match(/reverse_proxy/g)).toHaveLength(2);
    expect(result.content.match(/respond 404/g)).toHaveLength(2); // one per catch-all port block
  });

  it("the catch-all blocks make no backend contact and never mention a service name", () => {
    const result = renderTask({
      routes: [{ serviceId: "secret-internal-service", hostname: "public.example.tld", backendPort: 80, backendProtocol: "http" }],
    });
    const blocks = result.content.split("\n\n");
    const catchAllBlocks = blocks.slice(1); // everything after the one named site block
    expect(catchAllBlocks).toHaveLength(2);
    for (const block of catchAllBlocks) {
      expect(block).not.toContain("reverse_proxy");
      expect(block).not.toContain("secret-internal-service");
    }
  });

  it("the :80 catch-all never carries a tls directive, since Caddy rejects TLS on a plain-HTTP port", () => {
    const result = renderTask({ routes: [] });
    const port80Block = result.content.split("\n\n").find((b) => b.startsWith(":80"))!;
    expect(port80Block).not.toContain("tls");
  });

  it("renders zero site blocks plus the two-block catch-all when there are no routes yet", () => {
    const result = renderTask({ routes: [] });
    expect(result.content).toMatchInlineSnapshot(`
      ":443 {
      	tls internal
      	respond 404
      }

      :80 {
      	respond 404
      }
      "
    `);
  });

  it("switches every named site and the :443 catch-all to a static cert/key path once a stored cert is provided (T4.5); :80 stays plain", () => {
    const result = renderTask({
      routes: [{ serviceId: "kavita", hostname: "kavita.example.tld", backendPort: 5000, backendProtocol: "http" }],
      cert: { certPath: "/data/certs/wildcard/gen-3/fullchain.pem", keyPath: "/data/certs/wildcard/gen-3/key.pem" },
    });

    expect(result.content).toMatchInlineSnapshot(`
      "kavita.example.tld {
      	tls /data/certs/wildcard/gen-3/fullchain.pem /data/certs/wildcard/gen-3/key.pem
      	reverse_proxy http://wanfw_kavita:5000
      }

      :443 {
      	tls /data/certs/wildcard/gen-3/fullchain.pem /data/certs/wildcard/gen-3/key.pem
      	respond 404
      }

      :80 {
      	respond 404
      }
      "
    `);
    expect(result.content).not.toContain("tls internal");
  });
});
