/**
 * Fichiers des sondes de la supervision : les plus petits contenus que liraient les collaborateurs, sans donnée
 * personnelle, construits ici plutôt que gardés en fichiers binaires dans le dépôt.
 */

const CANAUX = 1;
const ECHANTILLONS_PAR_SECONDE = 16_000;
const BITS_PAR_ECHANTILLON = 16;
const DUREE_EN_SECONDES = 2;

/**
 * Audio de la sonde de transcription : du silence en WAV PCM, le format le plus simple, dont LiteLLM lit la durée pour
 * la facturer.
 */
export function audioDeSonde(): Blob {
  const octetsParBloc = (CANAUX * BITS_PAR_ECHANTILLON) / 8;
  const tailleDesDonnees = DUREE_EN_SECONDES * ECHANTILLONS_PAR_SECONDE * octetsParBloc;
  const tailleDeLEntete = 44;
  const tailleDuBlocFormat = 16;
  const codagePcm = 1;
  const vue = new DataView(new ArrayBuffer(tailleDeLEntete + tailleDesDonnees));
  const balise = (position: number, texte: string) => [...texte].forEach((c, i) => vue.setUint8(position + i, c.charCodeAt(0)));
  balise(0, "RIFF");
  vue.setUint32(4, tailleDeLEntete - 8 + tailleDesDonnees, true);
  balise(8, "WAVE");
  balise(12, "fmt ");
  vue.setUint32(16, tailleDuBlocFormat, true);
  vue.setUint16(20, codagePcm, true);
  vue.setUint16(22, CANAUX, true);
  vue.setUint32(24, ECHANTILLONS_PAR_SECONDE, true);
  vue.setUint32(28, ECHANTILLONS_PAR_SECONDE * octetsParBloc, true);
  vue.setUint16(32, octetsParBloc, true);
  vue.setUint16(34, BITS_PAR_ECHANTILLON, true);
  balise(36, "data");
  vue.setUint32(40, tailleDesDonnees, true);
  return new Blob([vue.buffer], { type: "audio/wav" });
}

/**
 * PDF de la sonde d'OCR, en base64 : une page d'une ligne. La page est petite, pour que son rendu, que lit le modèle,
 * coûte peu de jetons d'entrée.
 */
export function pdfDeSonde(): string {
  const contenuDeLaPage = "BT /F1 12 Tf 8 18 Td (Sonde de supervision LINAGORA) Tj ET";
  const objets = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 48] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${contenuDeLaPage.length} >>\nstream\n${contenuDeLaPage}\nendstream`,
  ];
  // La table des renvois donne la position de chaque objet en octets : un par caractère, le texte étant en ASCII.
  let pdf = "%PDF-1.4\n";
  const positions = objets.map((objet, i) => {
    const position = pdf.length;
    pdf += `${i + 1} 0 obj\n${objet}\nendobj\n`;
    return position;
  });
  const debutDeLaTable = pdf.length;
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${positions.map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${debutDeLaTable}\n%%EOF\n`;
  return btoa(pdf);
}
