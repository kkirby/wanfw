import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, renderTask } from "./index.js";

describe("proxy-caddy plugin (§8.4/§8.5)", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("proxy-caddy");
  });

  it("renders a single-service Caddyfile with tls internal and a catch-all", () => {
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

      :443, :80 {
      	tls internal
      	respond 404
      }
      "
    `);
  });

  it("renders a multi-service Caddyfile with one site block per route, in the given order, plus one catch-all", () => {
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

      :443, :80 {
      	tls internal
      	respond 404
      }
      "
    `);
    expect(result.content.match(/reverse_proxy/g)).toHaveLength(2);
    expect(result.content.match(/respond 404/g)).toHaveLength(1);
  });

  it("the catch-all makes no backend contact and never mentions a service name", () => {
    const result = renderTask({
      routes: [{ serviceId: "secret-internal-service", hostname: "public.example.tld", backendPort: 80, backendProtocol: "http" }],
    });
    const catchAllBlock = result.content.split("\n\n").at(-1)!;
    expect(catchAllBlock).not.toContain("reverse_proxy");
    expect(catchAllBlock).not.toContain("secret-internal-service");
  });

  it("renders zero site blocks plus the catch-all when there are no routes yet", () => {
    const result = renderTask({ routes: [] });
    expect(result.content).toMatchInlineSnapshot(`
      ":443, :80 {
      	tls internal
      	respond 404
      }
      "
    `);
  });

  it("switches every site and the catch-all to a static cert/key path once a stored cert is provided (T4.5)", () => {
    const result = renderTask({
      routes: [{ serviceId: "kavita", hostname: "kavita.example.tld", backendPort: 5000, backendProtocol: "http" }],
      cert: { certPath: "/data/certs/wildcard/gen-3/fullchain.pem", keyPath: "/data/certs/wildcard/gen-3/key.pem" },
    });

    expect(result.content).toMatchInlineSnapshot(`
      "kavita.example.tld {
      	tls /data/certs/wildcard/gen-3/fullchain.pem /data/certs/wildcard/gen-3/key.pem
      	reverse_proxy http://wanfw_kavita:5000
      }

      :443, :80 {
      	tls /data/certs/wildcard/gen-3/fullchain.pem /data/certs/wildcard/gen-3/key.pem
      	respond 404
      }
      "
    `);
    expect(result.content).not.toContain("tls internal");
  });
});
