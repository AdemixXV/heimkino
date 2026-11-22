// Einstellungen der Handy-App.
// clientId: die "Anwendungs-ID (Client-ID)" aus der App-Registrierung bei Microsoft (entra.microsoft.com).
// Sie ist nicht geheim. Solange sie leer ist, zeigt die App nur die Demo.
export const CONFIG = {
  clientId: '5f381a7a-925b-4085-8dd3-847dcc39ba82', // App "Heimkino" im privaten Standardverzeichnis, nur persönliche Konten
  // Ordner in OneDrive, die als Bibliothek erscheinen (Pfad ab der obersten OneDrive-Ebene)
  // (Videos/Handy bewusst nicht: private Handy-Aufnahmen gehören nicht in die App)
  // Festes Bibliothekslaufwerk: Jedes Konto verwendet seinen eigenen Token.
  // Die Kennung allein gewährt keinen Zugriff; OneDrive prüft die vorhandene Ordnerberechtigung.
  folders: [{ driveId: 'A77EB828D51F3C89', itemId: 'A77EB828D51F3C89!sc9a46288a9f24f479216629c96a78728', path: 'Filme/Handy', label: 'Filme' }],
  // Ein gemeinsames Wünsche-Brett im ausdrücklich gewählten eigenen Konto.
  // Bleibt beim Kontowechsel derselbe Ordner; OneDrive prüft dessen Freigabe.
  board: { driveId: 'f23e81c0222b88b4', itemId: 'F23E81C0222B88B4!s34785cf3a2f441059b1df8099fb4934a' },
};
