import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const local = host => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
const assertLocal = input => {
 const host = typeof input === "string" || input instanceof URL ? new URL(input).hostname : input?.hostname ?? input?.host ?? "localhost";
 if (!local(host)) throw new Error(`Offline tests blocked network request to ${host}`);
};
for (const module of [http, https]) {
 for (const method of ["request", "get"]) {
  const original = module[method];
  module[method] = function(input, ...args) { assertLocal(input); return original.call(this, input, ...args); };
 }
}
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => { assertLocal(input instanceof Request ? input.url : input); return fetch(input, init); };
syncBuiltinESMExports();

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
 const input=Array.isArray(args[0]) ? args[0] : args;
 const options=input[0];
 const host=typeof options === "object" ? options.host ?? options.hostname ?? "localhost" : typeof input[1] === "string" ? input[1] : "localhost";
 if (!local(host)) throw new Error(`Offline tests blocked socket to ${host}`);
 return connect.apply(this,args);
};
syncBuiltinESMExports();
