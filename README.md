# 🎵 Spotify → NewPipe Converter

Converti le tue playlist Spotify in file importabili su NewPipe (Android).

---

## ⚡ Installazione rapida

### 1. Installa Node.js
Scarica e installa Node.js da: https://nodejs.org (versione LTS consigliata)

### 2. Scarica il progetto
Decomprimi la cartella `spotify-to-newpipe` dove vuoi.

### 3. Installa le dipendenze
Apri il terminale nella cartella del progetto e scrivi:
```
npm install
```

### 4. Avvia il server
```
npm start
```

Il server stamperà il suo indirizzo IP locale, ad esempio:
```
   PC:       http://localhost:3000
   Telefono: http://192.168.1.42:3000
```

---

## 🔑 Come ottenere le credenziali Spotify (gratis, 2 minuti)

1. Vai su https://developer.spotify.com/dashboard
2. Accedi con il tuo account Spotify
3. Clicca **"Create App"**
4. Dai un nome qualsiasi (es. "NewPipe Converter")
5. In **Redirect URIs** scrivi: `http://localhost:3000` e salvalo
6. Clicca **Settings** → vedrai **Client ID** e **Client Secret**
7. Copialo nell'app!

---

## 📱 Come importare su NewPipe

1. Scarica il file `.json` generato dall'app
2. Trasferiscilo sul telefono (via cavo, cloud, Telegram a te stesso, ecc.)
3. Apri **NewPipe** sul telefono
4. Vai su **Playlist** (icona in basso)
5. Tocca i **tre puntini ⋮** in alto a destra
6. Seleziona **"Importa da file"**
7. Scegli il file `.json`
8. La playlist è nelle tue playlist locali! 🎉

---

## ❓ Note

- La playlist Spotify deve essere **pubblica** (o tua)
- La ricerca su YouTube trova il video ufficiale o il più pertinente
- Playlist molto lunghe (100+ brani) possono richiedere qualche minuto
- Dal telefono nella stessa rete Wi-Fi, usa l'indirizzo IP mostrato nel terminale
