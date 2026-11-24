# Screener Paper

Staattinen SOL/USD-kaupankäyntisovellus. Oletustila on Paper Trading. Selain lataa Rust-moottorin WebAssemblyna ja hakee hintatietoa suoraan DEX Screeneriltä. Solanan WebSocket näyttää slot-tilan. Ajo päättyy, kun sovellus siirtyy taustalle. Aiempi [repositorio- ja lisenssiauditointi](AUDIT.md) kuvaa alkuperäisen työpöytämoottorin ja selainportin rajat.

## Ajo ja testit

Repositorion juuressa, Rust 1.98.1 ja Node 24:

```sh
rustup target add wasm32-unknown-unknown
bash pwa/build-wasm.sh
rustc --edition 2021 --test pwa/engine.rs -o /tmp/screener-engine-tests
/tmp/screener-engine-tests
node --test pwa/*.test.mjs
python3 -m http.server 8018 --bind 127.0.0.1 --directory pwa
```

Toisessa terminaalissa:

```sh
npm ci --ignore-scripts
SCREENER_CHROMIUM=/usr/bin/chromium node pwa/smoke.mjs
SCREENER_CHROMIUM=/usr/bin/chromium node pwa/market-smoke.mjs
SCREENER_CHROMIUM=/usr/bin/chromium node pwa/scanner-smoke.mjs
SCREENER_CHROMIUM=/usr/bin/chromium node pwa/devnet-smoke.mjs
```

Jätä `SCREENER_CHROMIUM` pois, jos Playwrightin Chromium on asennettu. Node-testi tuottaa väliaikaisen Ed25519-avaimen ja simuloi Devnet RPC -vastausta. Selaintesti käyttää HTTP-, WebSocket- ja lompakkomalleja. Testit eivät lähetä transaktioita.

## Strategia ja paikallinen tallennus

Paper- ja Live-toteutusrajapinta käyttävät samoja signaali- ja riskisääntöjä. Valittavissa ovat alkuperäiseen indikaattorimoduuliin pohjautuvat RSI ja EMA-risteys sekä 20 havainnon hintamurto. Hinnat ovat näytteitä, eivät OHLCV-kynttilöitä. Sisääntuloa rajaavat likviditeetti, kassavara, position koko, toteutuneet UTC-päivän tappiot ja jäähyaika. Poistumissääntöjä ovat stop loss, break-even, trailing stop, aikaraja, enintään kaksi take profit -tasoa sekä strategian myyntisignaali. Valinnainen DCA sallii yhden lisäoston. Paper-kirja laskee mallinnetun liukuman, kulut ja toteutuneen P/L:n.

IndexedDB säilyttää asetukset, paperiposition, rajatun historian ja enintään 64 hintanäytettä. Vanhentunut näytehistoria hylätään käynnistyksessä. Kiinteä testisarja käyttää omaa kirjaa ja toimii offline-tilassa, kun sovellus on ladattu kerran. Wallet Standardilla voi yhdistää lompakon ja kokeilla Devnet-muistion allekirjoitusta. Sovellus tarkistaa allekirjoituksen sekä viestin muuttumattomuuden paikallisesti ja hävittää allekirjoitetun transaktion. Phantom-injektiota voi käyttää saldon lukemiseen. Kotinäytölle lisätyssä Safarissa lompakon löytyminen on vielä testattava fyysisellä iPhonella.

Live-ajon käynnistyspolku vaatii toimeenpanevan adapterin, lompakon ja käyttäjän vahvistuksen. Jakelussa ei ole mainnet-swap-adapteria. Live-kaupankäynti edellyttää reitittimen CORS-tukea, oikean swap-ohjelman ja tilien tarkistusta, simulaatiota, lähetyksen täsmäytystä sekä lompakkokohtaista toteumakirjaa. Lompakon yhden kerran vahvistus ei anna sivulle pysyvää allekirjoitusoikeutta.

## Markkinahaku, ehtopuut ja Copy Trading

Valitse pysäytetyssä Paper-tilassa pooli hausta tai uusien ja trendaavien poolien listoista. Jokaisella valitulla poolilla on oma paperikassansa ja riskirajansa. Avoimet positiot listataan yhdessä, mutta hinta, kaupankäynti ja positioiden aktiivinen seuranta kohdistuvat valittuun pooliin. Aiemmat markkinat näyttävät viimeisen tallennetun arvostuksen.

Oman strategian JSON sisältää `entry`- ja `exit`-puut. Ryhmä on esimerkiksi `{"op":"AND","children":[...]}`. Vertailu voi käyttää lukua tai toista mittaria arvona. Esimerkiksi `{"metric":"price","compare":"gt","value":{"metric":"sma","period":20}}` vertaa viime hintaa kynttilöiden liukuvaan keskiarvoon. Valitse kynttilöiden aikaväli ja tallenna puu. Valitse sitten riskiasetuksista **Oma ehtopuu**. Käytettävät mittarit ja operaattorit ovat [ehtopuutoteutuksessa](rules.js).

Paper Copy Trading lähettää tilauksia vain paperikirjaan. Tallenna seurattava Solana-lompakko, valitse pooli ja ota Copy Trading käyttöön riskiasetuksissa. Se lukee uusimmat vahvistetut Jupiter/USDC-tapahtumat, käyttää valittua tokenia ja soveltaa paikallisia osto- ja myyntirajoja. Ennen käynnistystä havaitut tapahtumat eivät tee toimeksiantoja. Live-näkymästä voi tuoda oman lompakon tunnistetut, jo vahvistetut Jupiter/USDC-kaupat ja hakea hinta-arvion. Hinta-arvio ei muodosta transaktiota. Katso [alkuperäisen toiminnallisuuden kattavuus](PORTING.md).

## Automaattinen monen poolin Paper-ajo

Valitse Paper Trading ja paina **Käynnistä Paper-skannaus**. Offline-kokeeseen valitse **Aja testisarja**. Automaattinen salkku löytää ja päivittää asetuksista valittavat 1–30 poolia ilman käsivalintaa. Avoimet positiot säilyvät seurannassa, vaikka pooli poistuu löydöstä. Automaattisella salkulla on yhteinen lähtökassa, pääomaraja ja päivittäinen tappioraja. Aiempi yksittäisen poolin ajo käyttää edelleen omaa kirjaansa. UTC-päivän ostoraja on automaattisessa salkussa yhteinen ja käsin valitussa ajossa kirjakohtainen. Myyntejä voi tapahtua ostorajan täyttymisen jälkeen. **Hätäpysäytys** keskeyttää ajon ja lukitsee uudet toimeksiannot yli uudelleenlatauksen. Vapauta lukitus ennen uutta käynnistystä. Skannauksessa voi käyttää RSI:tä, EMA-risteystä, hintamurtoa, omaa ehtopuuta tai enintään neljän lompakon Paper Copy Tradingia.

Live-näkymän **Muodosta ja simuloi swap** pyytää Jupiterilta allekirjoittamattoman paketin ja simuloi sen Solanan RPC:ssä. Toiminto edellyttää yhdistettyä lompakkoa. Jupiter-avaimen voi antaa tarvittaessa pyyntöä varten. Pakettia ei tallenneta tai lähetetä ketjuun. [Tiedostokohtainen porttiseuranta](PORTING-INDEX.md)

## Devnetin tapahtumatesti

Valitse Live Trading, avaa **Devnet-tapahtumatesti** ja luo tilapäinen testilompakko. Paina **Kopioi Devnet-osoite** ja liitä juuri luodun, samalla sivulla näkyvän testilompakon julkinen osoite virallisessa [Solanan faucetissa](https://faucet.solana.com/), jos sinulla on siellä pääsy testivaroihin. Älä siirrä osoitteeseen Mainnet-varoja. Pidä alkuperäinen sovellussivu avoinna. Uudelleenlataus hävittää istuntokohtaisen avaimen, joten uuden avaimen jälkeen osoite muuttuu. Kun Devnet-saldo on vahvistettu, **Lähetä Devnet-testimerkintä** lähettää vain Devnet-muistion. Tarkista lopputila erillisellä painikkeella. Jos sivu sulkeutui kesken lähetyksen, avaa vahvistusnäkymä uudelleen. Odottava allekirjoitus säilyy, avain katoaa, eikä sovellus lähetä epäselvää tapahtumaa uudelleen.

## Maksuton staattinen julkaisu ja iPhone

```sh
bash pwa/package-static.sh /tmp/screener-pwa
```

GitHub Actionsin **Build static Screener PWA** -työnkulku tekee vastaavan paketin manuaalisella käynnistyksellä. GitHub Free tukee maksutonta Pages-hostingia julkisille repositorioille. Julkaise lisenssin sallimalla tavalla. GitHub Pagesissa valitse **Settings → Pages → Source → GitHub Actions**. Käynnistä sitten oletushaaralta **Actions → Publish Screener PWA to GitHub Pages → Run workflow** ja merkitse lisenssioikeudet varmistetuiksi. Ajon `github-pages`-ympäristöstä saat HTTPS-osoitteen. Muualla HTTPS-hostauksessa pura staattisen ZIP-paketin tiedostot julkaisuhakemistoon. Staattinen paketti sisältää alkuperäisen lisenssin. Applen Safarissa valitse **Jaa → Lisää Koti-valikkoon**, ja avaa verkkosovelluksena, jos Safari näyttää asetuksen erikseen. Tämä työnkulku käyttää pilvessä tai CI:ssä tehtävää Rust-käännöstä.

DEX Screener vaatii selain-Originille sopivan GET-vastauksen, RPC JSON POST vaatii myös onnistuneen OPTIONS-esipyynnön ja WebSocket-palvelin voi rajoittaa Originia. Tarkista kaikki kolme lopullisesta HTTPS-osoitteesta. Suorien HTTP-kokeiden uusinnassa DEX Screener ja GeckoTerminal sallivat julkisen Originin. PublicNode sallii myös JSON-esipyynnön. Chromiumin ulkoinen koe pysähtyi pilven proxyn varmenteeseen. Lopullista HTTPS-julkaisua ei ole vielä testattu iPhonella. Staattinen hostaus voi olla maksuton. Solana mainnet -transaktioilla on verkkomaksuja.

[GitHub Pagesin saatavuus](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages) · [Applen asennusohje](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios) · [BUSL-1.1](LICENSE)

### Trojan V2 Main ja Sniper

Valitse strategia riskiasetuksista ja paina **Käynnistä Paper-skannaus**. Main käyttää REST-lähteiden ja PumpPortalin löydöksiä. Sniper hyväksyy analysoitaviksi kaupankäyntiehdokkaiksi vain PumpPortalin havaitsemat mintit. Molemmat käyttävät Trojan V2:n dip-reversal-pisteytystä sekä Screenerin Paper-salkun asetettuja likviditeetti-, volyymi-, pääoma- ja tappiorajoja. Trojan-profiilit vaativat lisäksi minttitarkistuksen ja RugCheck-yhteenvedon. Kun oma RugCheck-enimmäispistemäärä on 0, Trojan-profiilit käyttävät rajaa 30.

Löytöjono käsittelee enintään 600 aktiivista minttiä ja analyysi enintään 30 minttiä per erä. Dashboardin pooliraja vaikuttaa kaupankäyntiseurantaan. Lähteet päivittyvät 15–60 sekunnin välein ja avoimien positioiden hinnat normaalisti noin kolmessa sekunnissa. Puuttuvien tietojen ensimmäiset uudelleenhaut odottavat 10 sekuntia. Analyysitilastot ovat ajokohtaisia. Birdeyen avain on valinnainen ja säilyy vain ajon muistissa.

Mainin ja Sniperin selainportti käyttää alkuperäisiä pisteytysrajoja ja yhden aikavälin teknistä vahvistusta, kun kelvollista OHLCV-dataa on saatavilla. Alkuperäisen Trojan V2:n Jupiter-ostoanalyysi, ketjukohtaiset poolidekooderit, koko RugCheck-raportin haltija- ja LP-analyysi, moniaikavälisuodatus ja natiivi Live-toteutus jäivät selainportin ulkopuolelle. Nykyiset Screenerin Paper-simulaatio, poistumissäännöt ja riskirajat ovat käytössä.
