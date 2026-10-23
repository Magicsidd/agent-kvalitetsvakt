import { test } from "node:test";
import assert from "node:assert/strict";
import { Kunnskapsbase } from "../src/kunnskap/sok.ts";

const kb = Kunnskapsbase.fraFil();
const forste = (q: string) => kb.sok(q)[0]?.tittel;

test("finner riktig avsnitt med vanlige formuleringer", () => {
  assert.equal(forste("hva koster en tannrens"), "Priser");
  assert.equal(forste("når har dere åpent på lørdag"), "Åpningstider");
  assert.equal(forste("kan jeg parkere i nærheten"), "Adresse og parkering");
  assert.equal(forste("hva skjer hvis jeg må avlyse timen"), "Avbestilling");
  assert.equal(forste("kan jeg betale med vipps"), "Betaling");
  assert.equal(forste("jeg er veldig redd for tannlegen"), "Tannlegeskrekk");
});

test("ingen treff på ting kunnskapsbasen ikke dekker", () => {
  assert.equal(kb.sok("hvem vant fotball-VM").length, 0);
});
