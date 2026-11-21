import { describe, expect, test } from "vitest";
import { audioDeSonde, pdfDeSonde } from "./fichiers-de-sonde";

describe("fichiers envoyés par les sondes de la supervision", () => {
  test("l'audio de la sonde de transcription est un WAV PCM de 2 s, dont l'en-tête donne la durée", async () => {
    const audio = audioDeSonde();
    expect(audio.type).toBe("audio/wav");
    const octets = new Uint8Array(await audio.arrayBuffer());
    const vue = new DataView(octets.buffer);
    const balise = (position: number) => String.fromCharCode(...octets.subarray(position, position + 4));
    expect([balise(0), balise(8), balise(12), balise(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    const format = { codage: vue.getUint16(20, true), canaux: vue.getUint16(22, true), frequence: vue.getUint32(24, true), bits: vue.getUint16(34, true) };
    expect(format).toEqual({ codage: 1, canaux: 1, frequence: 16_000, bits: 16 });
    // Champs que le format WAV déduit des précédents, et tailles annoncées des blocs.
    const octetsParSeconde = vue.getUint32(28, true);
    expect(octetsParSeconde).toBe((format.frequence * format.canaux * format.bits) / 8);
    expect(vue.getUint16(32, true)).toBe((format.canaux * format.bits) / 8);
    expect(vue.getUint32(4, true)).toBe(octets.length - 8);
    expect(vue.getUint32(40, true)).toBe(octets.length - 44);
    expect(vue.getUint32(40, true) / octetsParSeconde).toBe(2);
  });

  test("le PDF de la sonde d'OCR a une page d'une ligne, et sa table des renvois pointe sur chacun de ses objets", () => {
    const pdf = atob(pdfDeSonde());
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf).toContain("/Count 1 ");
    expect(pdf.match(/\(.*?\) Tj/g)).toEqual(["(Sonde de supervision LINAGORA) Tj"]);
    const [, longueur, flux] = pdf.match(/<< \/Length (\d+) >>\nstream\n(.*)\nendstream/) ?? [];
    expect(flux).toHaveLength(Number(longueur));

    const [, table] = pdf.match(/startxref\n(\d+)\n%%EOF\n$/) ?? [];
    expect(pdf.slice(Number(table)).startsWith("xref\n")).toBe(true);
    const renvois = [...pdf.slice(Number(table)).matchAll(/^(\d{10}) 00000 n $/gm)].map(([, position]) => Number(position));
    expect(renvois).toHaveLength(pdf.match(/^\d+ 0 obj$/gm)?.length ?? 0);
    renvois.forEach((position, i) => expect(pdf.slice(position).startsWith(`${i + 1} 0 obj\n`)).toBe(true));
    expect(pdf).toContain(`/Size ${renvois.length + 1} `);
  });
});
