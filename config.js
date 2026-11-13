// Einstellungen der Handy-App.
// clientId: die "Anwendungs-ID (Client-ID)" aus der App-Registrierung bei Microsoft (entra.microsoft.com).
// Sie ist nicht geheim. Solange sie leer ist, zeigt die App nur die Demo.
export const CONFIG = {
  clientId: '5f381a7a-925b-4085-8dd3-847dcc39ba82', // App "Heimkino" im privaten Standardverzeichnis, nur persönliche Konten
  // Ordner in OneDrive, die als Bibliothek erscheinen (Pfad ab der obersten OneDrive-Ebene)
  // (Videos/Handy bewusst nicht: private Handy-Aufnahmen gehören nicht in die App)
  folders: [{ path: 'Filme/Handy', label: 'Filme' }],
};
