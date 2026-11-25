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

DEX Screener vaatii selain-Originille sopivan GET-vastauksen, RPC JSON POST vaatii myös onnistuneen OPTIONS-esipyynnön ja WebSocket-palvelin voi rajoittaa Originia. Tarkista kaikki kolme lopullisesta HTTPS-osoitteesta. Suorien HTTP-kokeiden uusinnassa DEX Screener ja GeckoTerminal sallivat julkisen Originin. PublicNode sallii myös JSON-esipyynnön. Chromiumin ulkoisen kokeen tulokset on kuvattu alla. Lopullista HTTPS-julkaisua ei ole vielä testattu iPhonella. Staattinen hostaus voi olla maksuton. Solana mainnet -transaktioilla on verkkomaksuja.

[GitHub Pagesin saatavuus](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages) · [Applen asennusohje](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios) · [BUSL-1.1](LICENSE)

### Trojan V2 Main ja Sniper

Valitse strategia riskiasetuksista ja paina **Käynnistä Paper-skannaus**. Main käyttää REST-lähteiden ja PumpPortalin löydöksiä. Sniper hyväksyy analysoitaviksi kaupankäyntiehdokkaiksi vain PumpPortalin havaitsemat mintit. Molemmat käyttävät Trojan V2:n dip-reversal-pisteytystä sekä Screenerin Paper-salkun asetettuja likviditeetti-, volyymi-, pääoma- ja tappiorajoja. Trojan-profiilit vaativat lisäksi minttitarkistuksen ja täyden RugCheck-raportin. Kun oma RugCheck-enimmäispistemäärä on 0, Trojan-profiilit käyttävät rajaa 30.

Löytöjono käsittelee enintään 1 000 PumpPortal- ja 1 000 muuta aktiivista minttiä ja analyysi enintään 30 minttiä per erä. Dashboardin pooliraja vaikuttaa kaupankäyntiseurantaan. Useimmat aktiiviset lähteet päivittyvät 15–60 sekunnin välein ja avoimien positioiden hinnat normaalisti noin kolmessa sekunnissa. Puuttuvien tietojen ensimmäiset uudelleenhaut odottavat 10 sekuntia. Analyysitilastot ovat ajokohtaisia. Birdeyen avain on valinnainen ja säilyy vain ajon muistissa.

Mainin ja Sniperin selainportti käyttää Trojan V2:n dip-reversal-pisteytystä, säädettäviä hakurajoja ja teknistä moniaikavälivahvistusta, kun kelvollista OHLCV-dataa on saatavilla.

#### Trojanin osto- ja turvallisuusanalyysi

Main ja Sniper lukevat RugCheckin täydestä raportista omistajakeskittymän, tekijäosuuden, sisäpiirilinkit, LP-lukituksen ja markkinalikviditeetin. Tunnetuille Solana-ohjelmille tarkistetaan poolitilin omistaja, rakenne, tila ja tokenpari ennen Jupiter v2 -tarjousta. Puuttuvaa tai ristiriitaista turvallisuustietoa ei hyväksytä. Analyysiloki näyttää tilan, pisteet ja syyn enintään 60 tuoreimmalle merkinnälle.

Jupiter tarkistaa WSOL-määrän, reittipisteet, hintavaikutuksen ja liukuman. Valinnainen julkinen simulaatio-osoite ottaa käyttöön allekirjoittamattoman RPC-simulaation sekä tarjousten tuottovertailun. Avain ja osoite ovat ajoasetuksia. Main- ja Sniper-Paper-oston oletuskatto on 5 USD ja 10 % käytettävästä kassasta. Profiilikohtaiset asetukset, vähintään 1 USD:n toteutuskoko ja salkun riskirajat ohjaavat mitoitusta.

Tekninen vahvistus käyttää 1 min kynttilöitä ja niistä muodostettuja kokonaisia 3 min, 5 min, 15 min, 30 min, 1 h ja 4 h jaksoja. Vajaat tai historiattomat aikavälit eivät anna ääntä. Enintään 480 yhden minuutin kynttilää rajoittaa sitä, kuinka monta pidempää aikaväliä voi lämmetä samasta historiasta.

Selainportti ei kata Trojanin kaikkia ympäristömuuttujilla ohjattuja sääntöjä, kaikkia protokollakohtaisia holvi-, tick-, bin- ja maksulaskelmia, natiivia poolireititystä eikä Live-lähetystä. Poolit, joiden tokenparia ei voi varmistaa tilin asettelusta, jäävät odottamaan. Julkaistun iPhone-selaimen verkkotesti on edelleen avoin.

## Aggressive Momentum ja agenttinäkymät

Valitse **Paper Trading → Settings → Strategia ja riskirajat → Aggressive Momentum (Paper)**, tallenna asetukset ja käynnistä Paper-skannaus. Paper-alkupääoma (oletus 1 000 USD) koskee vasta luotavaa skannaussalkkua. Tallennettu salkku palautetaan edellisestä tilasta. Main, Sniper ja yhdistelmä ovat valittavissa samassa valikossa.

- **Scanner** pitää lähteet, PumpPortal-yhteyden ja deduplikoidun jonon käynnissä erillään positioiden kierrosta. Main- ja Sniper-ehdot sekä pisteytys pohjautuvat Trojan V2:n koodiin. Sniper ottaa analyysijonoon PumpPortal-havainnot. Laajat tunnin välein luettavat katalogit toimivat rajattuina varalähteinä. Palvelukohtaiset tauot huomioivat HTTP 429:n ja luettavissa olevan `Retry-After`-otsakkeen.
- **Analyst** pisteyttää erät selaimen moduulityöntekijässä. Palvelinpyyntöjen rinnakkaisuutta rajaavat työjonon pituus, laitteen ilmoittama ydinmäärä ja asetuksissa valittu 1–24 erätyöntekijän katto. Mintti-, pooli-, RugCheck- ja Jupiter-tarkistusten valmistuminen voi tuoda ehdokkaan nopeasti uudelleen käsittelyyn. Käytetty markkinadata säilyttää alkuperäisen hakuhetkensä välimuistissa.
- **Brain** käyttää momentumin pisteisiin markkinalaatua, 5 min ostopainetta ja volyymin kiihtymistä suhteessa 1 h tahtiin sekä hintatrendiä. Aloitusraja on 80/100. Vahva positio voi pysyä avoinna voittotavoitteen yläpuolella. Heikkenevä trendi voi johtaa osittaiseen voitonkotiutukseen tai poistumiseen. Aseta voitto-osuus alle 100 %:iin, jos haluat osamyyntejä. Strategia on sääntöpohjainen.
- **Executor** laskee Paper-toteumat hinta- ja likviditeettidatasta sekä asetusten kulu- ja liukumamallista. Toteutus, salkku ja päätös kirjataan yhdessä IndexedDB-transaktiossa. Vapautunut käteinen palaa salkkuun. Myyntistatistiikka laskee kirjatut myyntitoteumat mukaan lukien osamyynnit.
- **Risk** säilyttää mintti-, omistaja-, likviditeetti-, pooli- ja Jupiter-ostotarkistukset. Momentum tarkistaa myös Jupiterin vastakkaisen myyntireitin ja hylkää yli 5 %:n edestakaisen hintavaikutuksen tarjouksissa. Kaupan enimmäiskokoa rajoittavat käteinen, likviditeetti, pisteet ja asetukset. Positioita suojataan kokonaisaltistuksella, tappio- ja ostorajoilla, stop lossilla, break-evenillä, dynaamisella trailing-tasolla sekä likviditeetin putoamiseen perustuvalla poistumisella. Myös manuaalinen paperisulku vaatii tuoreen kelvollisen hinnan.

Home näyttää tallennetuista salkun noteerauksista piirretyn arvokäyrän. Agents näyttää ohjelman rajallisten työjonojen, verkkolähteiden ja kauppakirjan telemetrian. Feed ja tokenin tiedot näyttävät tallennettuja päätöksiä ja kauppoja. Kaavion merkit kohdistuvat saman poolin tallennettuihin Paper-kauppoihin. Jos palvelu ei anna kelvollista hintaa tai reittiä, sovellus jättää simulaatiototeuman tekemättä. Sovelluksen siirtyminen taustalle pysäyttää skannauksen.

Live-tilassa ovat käytettävissä olemassa oleva lompakkoyhteys, ketjussa vahvistettujen Jupiter/USDC-tapahtumien tuonti ja simulaatiopolut. Julkaisussa ei ole ketjuun lähettävää mainnet-adapteria. Aggressive Momentum on Paper-strategia.

### Aidon markkinadatan 15 minuutin Paper-vertailu Node 24:llä

```sh
SCREENER_BENCH_PAIRS=/tmp/screener-pairs.jsonl node --use-env-proxy pwa/paper-benchmark.mjs
```

`SCREENER_BENCH_STRATEGY=5` vaihtaa Mainiin ja `=6` Sniperiin. Testi ajaa selaimen kanssa jaettua moottoria ilman selaimen workeria tai pysyvää salkkua. Tavalliset markkina- ja lukukutsut sallitaan. Transaktioiden lähetys estetään. Valinnainen tiedosto sisältää enintään 300 todellista DEX-parivastausta Main/Sniper-vertailua varten.

### Kohdistetut selaintestit

```sh
SCREENER_SCANNER_PROFILE=momentum SCREENER_CHROMIUM=/usr/bin/chromium node pwa/scanner-smoke.mjs
SCREENER_SCANNER_PROFILE=momentum SCREENER_BROWSER=webkit node pwa/scanner-smoke.mjs
```

GitHub Pages -asennuksessa valitse sivuston lähteeksi **GitHub Actions**. Yhdistämisen ja lisenssin käyttöehdon tarkistuksen jälkeen käynnistä **Publish Screener PWA to GitHub Pages** -työnkulku `main`-haaralta ja merkitse lisenssitarkistus. Kun julkaisu on valmis, avaa Pages-osoite iPhonen Safarissa, napauta **Jaa → Lisää Koti-valikkoon → Lisää** ja käynnistä sovellus kuvakkeesta. Avaa sovellus verkossa kerran, jotta sovelluspaketti tallentuu. Markkinaseuranta tarvitsee toimivan verkon.

### Testaus ja rajat

Staattisesta alihakemistopaketista läpäisivät 45 JavaScript-yksikkötestiä, 11 Rust-testiä ja kuusi Chromiumin selaintestiä. Aggressive Momentumin kahden poolin Paper-ostot, riskimyynnit, yhteysvirheestä toipuminen ja IndexedDB-historia läpäisivät myös WebKitin iPhone 13 -emulaatiossa. Etusivun 390 pikselin leveys, WebAssembly-moduulin käyttö ja sovelluskuoren lataaminen välimuistista paikallisen HTTP-palvelimen sulkemisen jälkeen tarkistettiin WebKitissä. Selaimen kaupankäyntiskenaariot käyttivät tunnettuja testivastauksia.

Oikeat DEX Screenerin, GeckoTerminalin, RugCheckin, Jupiterin, Jupiter Liten, CoinGeckon ja DeFiLlaman lukuvastaukset olivat luettavia Chromiumissa paikallisesta Originista. PumpPortal toimitti uuden mintin selaimen WebSocketiin. Jupiter palautti luettavat, allekirjoittamattomat WSOL/USDC-hinta-arviot molempiin suuntiin. Solanan pää-RPC palautti testipyynnölle 403:n ja PublicNode-varayhteys 200:n. Hallitun testiproxyn varmenne ohitettiin vain näissä Chromiumin julkisen datan tarkistuksissa. Birdeye jäi ilman avainta testaamatta. Fyysinen iPhone, Pages-julkaisun Origin ja todellinen Live-lähetys vaativat omat tarkistuksensa.

Aiemmassa 113 tokenin Main-ajossa 103 jäi odottamaan. Raportti sisälsi vain kokonaistilastot, joten yksittäisiä päätöksiä ei voinut jäljittää. Aiemmassa putkessa pitkäksi venyvä tarkistus saattoi varata kokonaisen analyysierän, ja odotuskierroksen väli kasvoi. Uusi toteutus erottaa markkinahaun turvallisuus- ja reittityöstä, käyttää 10 sekunnin strategiauusintaa ja käsittelee tasan menevän osto- ja myyntivirran alkuperäisen Trojanin mukaisena odotuksena. Käyttäjän asetukset ja turvallisuusrajat voivat edelleen siirtää ehdokkaan odottamaan tai hylätä sen.

### Paper ja Trojan V2 samassa markkina-aineistossa

Aidon datan Momentum-ajon kesto oli 15 min 5 s. Skanneri löysi ja analysoi 996 minttihavaintoa, joista PumpPortal havaitsi ensimmäisenä 86. Tarkistuksia tehtiin 47 464, kun uudelleenanalyysit lasketaan mukaan. Keskimääräinen markkinahaku ja päätöskierros kesti 291 ms/token ja löydöstä ensimmäiseen analyysiin kului keskimäärin 3,38 s. Löytötahti oli koko ajon yli noin 66/min. Rinnakkain oli enimmillään kolme analyysierää ja jonossa enimmillään 469 odottavaa ehdokasta. Turvallisuuden tai strategian perusteella hylättiin 97 minttihavaintoa. Hyväksyttyjä signaaleja ja kauppoja oli 0. Tavallisimmat syyt olivat puuttuva poolihinta, heikko momentum ja puuttuva lyhyen aikavälin kauppadata. Syyluvut sisältävät tilasiirtymiä, joten sama mintti voi näkyä useassa syyssä. DEX Screener, GeckoTerminal, Jupiter Lite ja pää-RPC palauttivat ajoittain HTTP 429 -vastauksia. Osa mittauksesta osui samaan aikaan aiemman Paper-koeajon kanssa.

Samasta ajosta poimittiin 300 todellista DEX-parivastausta. Selaimen JavaScript ja Trojan V2:n Python-versio (`b3b82fe`) saivat samat markkinatiedot, mittaushetket ja lähteet. Quality-pisteet ja alkuperäisten oletusten Main- ja Sniper-analyysit täsmäsivät kummassakin 300/300. Screener-iOS:n lisärajoilla päätökset täsmäsivät Mainissa 298/300 ja Sniperissä 296/300. Yksi Sniperin hyväksyntä muuttui odotukseksi. Vertailu koski pisteytystä ja analyysipäätöstä ennen selainversion lisätarkistuksia.

Pilviympäristön CPU-kokeessa 30 000 markkinarivin Quality-, Main- ja Sniper-laskenta kesti JavaScriptillä 146 ms ja Pythonilla 595 ms. Varsinaiseen tokenien etsinnän ja kaupankäynnin vertailuun tarvittaisiin samaan aikaan ajettu Trojan V2:n koko putki. Aidon datan ajossa kauppoja ei kirjattu, joten sen perusteella ei voi arvioida täyttöastetta eikä tuottoa. Saman tokenin uudelleenostojäähy ja vanhan ostonoteerauksen esto testattiin erikseen.

### Momentumin tuntikoe ja kalibrointi

GeckoTerminalin uusien ja trendaavien poolien vastauksista käytetään tokenparia, hintaa, likviditeettiä, volyymiä, hintamuutoksia ja tapahtumamääriä. DEX Screener on ensisijainen lähde. GeckoTerminal täydentää puuttuvaa markkinakuvaa tuoreella kokonaisella vastauksella samasta poolista tai tarjoaa tarkistettavan poolin, kun ensisijainen lähde ei löytänyt tokenia. Yksittäisiä täydennyshakuja tehdään enintään yksi kahdeksassa sekunnissa. Jos kumpikaan lähde ei anna varmennettavaa hintaa, Paper-kirja ei muodosta toteumaa.

PumpPortalin migraatio herättää ehdokkaan uudelleen arvioitavaksi. Solanan WebSocket seuraa yhteensä enintään kahdeksaa lupaavaa tai avointa poolia. Tilimuutos aikaistaa varsinaista hintahakua, ja avoimien poolien normaali hintapollaus jatkuu yhteysvirheiden varalta. Volyymikiihtyvyyttä verrataan 5 minuutin jaksoa edeltävään ajanjaksoon, korkeintaan 55 minuuttiin. Vähintään viisi toteutunutta kauppaa tarvitaan ostopaineen arvioimiseen. Nuoren poolin puuttuva vertailujakso edellyttää vahvempaa havaittua kauppamäärää, ostopainetta ja volyymiä suhteessa sen likviditeettiin.

Paper-ostoa yritetään vähintään sekunti reittitarkistuksen jälkeen tuoreella hinnalla. Uusi noteeraus, oston hintapoikkeama ja voimassa oleva Jupiter-reitti ratkaisevat, voiko toteumaa simuloida. Kulut ja liukuma lasketaan toteumiin. Heikkenevän voitollisen position ensimmäinen kotiutus on erikseen säädettävä, oletuksena 50 %. Toinen osuus vapautuu poistumisehdon täyttyessä. Saman tokenin uudelleenostossa noudatetaan edelleen kauppajäähyä.

```sh
SCREENER_BENCH_SECONDS=3605 node --use-env-proxy pwa/paper-benchmark.mjs > /tmp/paper-momentum-60m.jsonl
```

Testi raportoi analyysin vaiheet ja syyt. Mintti voi näkyä eri vaiheissa ja syissä, jos sen tiedot täydentyvät tai muuttuvat. Pisterajavertailu laskee ehdokkaat, jotka täyttivät muut momentumin ehdot. Se kuvaa pisterajan herkkyyttä ennen mintti-, RugCheck-, likviditeetti- ja reittitarkistuksia. Nettonoteeraus sisältää kassan ja avoimet positiot viimeisillä hinnoilla. Voittoprosentti ja pitoaika lasketaan kokonaan suljetuista positioista, osamyynnit mukaan lukien. Arvonalenema lasketaan simuloidun salkun noteeratuista huipuista.

Aiemmasta 15 minuutin ajosta tallennetuilla 300 aidolla DEX-parivastauksella vanha ja uusi pisteytys päästivät kumpikin viisi rajan 80 läpi. Uuden pisteytyksen rajat 70, 72 ja 76 päästivät kukin seitsemän, raja 84 kolme ja raja 88 yhden. Kun uuden pisteytyksen viiden ehdokkaan mintit ja RugCheck tarkistettiin erikseen nykyisestä ketju- ja raporttidatasta, kaksi pysähtyi minttitarkistukseen ja kolme RugCheckiin. Pisteraja säilytettiin 80:ssä. Tämä testi ei käytä historiasta arvattuja RugCheck-tiloja tai oston jälkeistä tuottoa.

### Lyhyen aikavälin Paper-signaali ja oppiminen

Momentum käyttää kolmea arviointipolkua. Perinteinen polku lukee palvelun viiden minuutin jaksoa. Lyhyt polku käyttää saman poolin aikaleimattuja kauppoja. Varhaisen virtauksen polku voi arvioida hinnaltaan ja likviditeetiltään tunnetun poolin ennen viiden minuutin tietojen valmistumista. Se edellyttää mitattua ostovirtaa, riittävää dollarivolyymia ja mallinnetut kulut ylittävää hintaliikettä. Puuttuva aineisto merkitään odotukseksi. GeckoTerminalin kokonainen poolivastaus voi korvata puuttuvan DEX-noteerauksen. Ilmoitus uudesta datasta lyhentää uudelleenanalyysin odotusta, myös silloin kun ehdokas on jo analyysissä.

Oppiminen käyttää suljettujen Paper-positioiden toteutunutta nettotulosta sekä saman poolin aikaisintaan kahden minuutin päästä saatua noteerausta. Hintaseurantahavaintoihin vähennetään kulut ja arvioitu liukuma. Tulokset tallennetaan IndexedDB:hen. Kolme polkua kalibroidaan erikseen käyttäjän pisterajan ympärillä. Pisterajaa voidaan laskea enintään neljä pistettä, kun vähintään 18 eri poolin pisterajan lähellä olevaa ja mintti- sekä RugCheck-tarkistettua havaintoa tukevat sitä. Riittävä tappiollinen aineisto voi nostaa rajaa enintään kuusi pistettä. Puuttuva hintadata ja turvallisuushylkäykset eivät kelpaa pisterajan laskemisen aineistoksi. Hintaseuranta ei ole toteutunut kauppa.

Jokainen ostettava token tarvitsee edelleen tuoreen hinnan, riskirajan täyttävän likviditeetin, hyväksytyn mintti- ja RugCheck-tarkistuksen, varmennetun poolin sekä Jupiterin osto- ja myyntireitin. Paper-kirja soveltaa pääoma-, altistus-, tappio-, osto- ja jäähyrajoja sekä mallinnettua toteutusviivettä. Nopean signaalin position voi sulkea aikaisin, jos aikaleimattu lyhyen aikavälin kauppavirta osoittaa käänteen ja liike jää kulujen alle.

```sh
SCREENER_BENCH_SECONDS=3605 SCREENER_BENCH_LEARNING=/tmp/paper-learning.json \
  node --use-env-proxy pwa/paper-benchmark.mjs > /tmp/paper-momentum-adaptive.jsonl
```

Jupiter v2:n hintavaikutus voi olla etumerkillinen. Sovellus muuntaa `priceImpactPct`-suhdeluvun prosenttiyksiköiksi ja tarkistaa itseisarvon. `priceImpact`-varakenttä on jo prosenttiyksiköissä. Oston ja vastakkaisen myyntireitin tarkistukset, kolmen prosentin reittikohtainen enimmäisvaikutus ja viiden prosentin edestakainen enimmäisvaikutus säilyvät.

#### Paper-oppimisen havaintohorisontit ja malliversiot

Tuoreita poolihintoja tallennetaan saatavuuden mukaan 15, 30, 60, 120, 300, 900 ja 3 600 sekunnin kohdalla. Pidemmille horisonteille varataan rajattu otos. Vain toteutusaikaan oikeasti saatavilla olevasta noteerauksesta syntyy havainto. Mallin varsinainen hintaseurantahorisontti on 120 sekuntia. Lyhyemmät ja pidemmät havainnot säilytetään erikseen, jotta samaa toteumaa ei lasketa moneen kertaan.

Ostopaineen, volyymitahdin, hintaliikkeen ja likviditeetin yhteyttä kustannuskorjattuun nettotulokseen arvioidaan erikseen tokenin iän, tuntitrendin ja signaalipolun mukaan. Toteutuneet Paper-positiot ja hintaseuranta käytetään eri ryhmissä. Hintaseurantalabeli voi ohjata mallia vasta mintti- ja RugCheck-tarkistusten jälkeen. Painon muutoksen hyväksyntä vaatii vähintään 36 eri poolin aineiston ja saman suuntaisen vaikutuksen kronologisessa tarkistusaineistossa. Painojen vaikutus signaaliin rajataan neljään pisteeseen, ja turvallisuus- sekä pääomaportit suoritetaan edelleen ennen ostoa.

Paper-oppimisesta säilytetään kymmenen viimeisintä strategiamallia. Asetuksen **Edellinen tallennettu malli tai lähtöasetukset** voi ottaa käyttöön pysäytetyssä Paper-tilassa. Se lukitsee edellisen mallin käytön. Havaintoja voi edelleen kertyä, ja valinta tallentuu sovelluksen asetuksiin. GeckoTerminalin pooli- ja kauppahaut jakavat pyyntötahtinsa ja yhteisen kiintiötaukonsa.

#### Poolin tunnistus, toteutustarjoukset ja vaiheloki

Momentum erottaa listauksesta puuttuvan poolin, puuttuvan USD-hinnan, puuttuvan likviditeetin, nollahinnan, nollareservin ja vanhentuneen noteerauksen. DEX Screenerin quote-puolen tokenille voidaan laskea USD-hinta vain samassa vastauksessa annetusta base-hinnasta ja parin hintasuhteesta. USD-kynttilöitä ei käännetä tämän perusteella. Jupiterin tokenihaku antaa pooliehdokkaita. Pooliehdokkaan tokenpari varmistetaan GeckoTerminalin vastauksesta. Jupiterin tokenitason likviditeettiä ei käsitellä tietyn poolin likviditeettinä.

PumpPortalista saatua bonding curve -osoitetta verrataan mintille johdettuun kanoniseen osoitteeseen. Solana RPC:n vahvistettu tilannekuva antaa mintin desimaalit, vastavaluutan ja reservit. USD-noteeraus saadaan mitatusta SOL- tai USDC-hinnasta. Likviditeetti perustuu oikeaan myyntivastavaluutan reserviin. SOL-curvejen tarkkailussa voidaan lisäksi käyttää Pump-ohjelman vahvistettuja TradeEvent-lokeja. GeckoTerminalin ja RPC:n kauppatapahtumia ei lasketa yhteen samalta poolilta. Token-2022-mintti voi edetä riskitarkistukseen, kun minttaus- ja jäädytysvaltuudet puuttuvat ja ainoat ilmoitetut laajennukset koskevat metadataa. RugCheck ja poolin tarkistus tehdään normaalisti.

Jupiterin read-only-esitarkistus käynnistyy lupaavalle signaalille rinnakkain muiden turvallisuustarkistusten kanssa. Paper-ostoon vaaditaan kaikki tarkistukset, soveltuva poolisyvyys, vahvistettu mintin desimaali ja poolin hintaa vastaava kaksisuuntainen tarjous. Automaattinen Paper-myynti odottaa kyseiselle määrälle saadun tuoreen Jupiter-tarjouksen. Epäonnistuneessa myynnissä positiota merkitään edelleen tuoreella markkinahinnalla. Toteutunut Paper-myynti käyttää enintään tarjouksen ja liukuman mukaista hintaa.

Hintaseuranta pitää aiemmat markkinahavainnot tallessa. Koulutusdataksi kelpaa suljetun Paper-position nettotulos tai turvallisuustarkistetun ehdokkaan vastaava virtuaalinen havainto. Virtuaalinen havainto vaatii pyyntöhetken osto- ja myyntireitit sekä 120 sekunnin kohdalla tarkan tokenimäärän uuden myyntitarjouksen. Virtuaalinen seuranta ei muuta Paper-saldoa. Hintamerkit ilman näitä tarjouksia säilyvät diagnostiikassa. Pistekynnyksen ja painojen mukautus tarkistetaan erillisessä kronologisessa aineistossa.

Sama Paper-ajo tuottaa vaiheiden läpäisyt ja syyt. Valinnainen trace-tiedosto kirjaa tokenkohtaiset vaiheiden muutokset ja toteumat.

```sh
SCREENER_BENCH_SECONDS=3605 SCREENER_BENCH_LEARNING=/tmp/paper-learning.json \
  SCREENER_BENCH_TRACE=/tmp/paper-stage-trace.jsonl \
  node --use-env-proxy pwa/paper-benchmark.mjs > /tmp/paper-funnel.jsonl
```
