# ScreenerBotin selainportin kattavuus

Lähtöpuu on ScreenerBot 0.2.26. Aiempi [auditointi](AUDIT.md) sisältää riippuvuus-, alustayhteensopivuus- ja lisenssihavainnot. Tämä seuranta erottaa toteutetut selainpolut ja alkuperäisen moottorin jäljellä olevat osat. Tiedostoinventaario kattaa Gitin seuraamat Rust-lähteet hakemistoittain. Toimintavertailu perustuu alla lueteltuihin toteutuspolkuihin. Jokaisen funktion käyttäytymispariteettia ei ole tarkistettu.

| Alkuperäinen vastuu | Selainpolku | Jäljellä |
|---|---|---|
| `strategies/{types,engine}.rs`, `strategies/conditions` | Muokattavat entry- ja exit-puut, AND/OR/NOT ja kolmiarvoinen tulos puuttuville tiedoille. RSI, SMA, EMA, hajonta, VWAP ja ATR kutsuvat alkuperäistä Rust-indikaattorimoduulia WASMina. | Alkuperäisten puiden ja mallien suora tuonti, poiskytketyt solmut, täydet ehto- ja aikaväliparametrit sekä tulospariteetti. |
| `ohlcvs`, `apis/geckoterminal` | Valitun poolin ja tokenin USD-kynttilät, järjestäminen, duplikaattien käsittely, paikallinen haku, välimuisti ja UTC-aggregointi. Automaattiset puut jättävät keskeneräiset tai vanhentuneet kynttilät pois. | Transaktioista rakennettava pitkä historia, aukkojen täydennys ja palveluntarjoajien vaihto. |
| `tokens`, `pools`, `filtering`, `apis/dexscreener` | DEX Screenerin nimi-, tunnus- ja osoitehaku, GeckoTerminalin uudet ja trendaavat poolit, likviditeetti- ja volyymiseulonta, Solana-poolin valinta ja hintapollaus. | Automaattinen useiden tokenien seulonta ja ajo, alkuperäiset metatieto-, riskipiste-, RugCheck-, blacklist-, provenance- ja moniketjusuodattimet. |
| `trader/{evaluators,safety,paper}`, `positions` | Paperin toimeksiannot käyttävät yhteisiä riskirajoja, kulumallia ja poistumissääntöjä. Poolikohtaiset kirjat, avoimien positioiden lista, viimeisin P/L ja tapahtumaloki. | Yksi jaettu kassakirja ja kokonaissalkun riskiraja, yhtäaikainen monen poolin hallinta, kaikki alkuperäiset sääntöyhdistelmät ja toteumaverrokit. |
| `trader/copy`, `transactions`, `wallets/watch` | Paper-copy seuraa enintään neljää lompakkoa sekä valittuja tokeneita. Vaatii vahvistetun, lompakon allekirjoittaman Jupiter/USDC-tapahtuman ja vastakkaissuuntaiset token-saldojen muutokset. Vanha lähtötilanne ei muodosta toimeksiantoja. | Profiilikohtainen mitoitus, muut swap-reitittimet ja quote-valuutat, natiivin SOL:n muutosten erottelu, osittaismyyntien suhteellinen kopiointi, live-copy. |
| `chains/solana/swaps`, `swaps`, `rpc` | Jupiter ExactIn -hinta-arvio, atomimäärät ja liukumarajan tarkistus. Solanan RPC ja slot-tilaus selaimesta. | Jupiterin allekirjoittamattoman swapin muodostus ja simulaatio ovat käytettävissä. Jäljellä ovat ohjelmien ja tilien sallintatarkistus, simulaatio, lähetys, uudelleentarkistus ja varmistettu mainnet-reititys. |
| `wallets`, `secure_storage`, `chains/solana` | Wallet Standardin Devnet-allekirjoitustesti, erillinen Devnet-muistiolähetys ja täsmäytys, Phantom-saldo, vahvistettujen Jupiter/USDC-kauppojen tuonti allekirjoituksen tunnisteella lompakko- ja tokenkohtaiseen kirjaan. | Tuotannon swap-allekirjoitus, natiivin lompakkonäkymän iOS-paluupolku, toteutuneiden Live-positioiden ja kulujen täysi täsmäytys. |
| `webserver`, `config`, `storage`, `services`, `run`, `global`, `process`, `paths`, `net`, `connectivity` | Staattinen dashboard, IndexedDB, näkyvyyteen sidottu ajo ja service worker. | Työpöydän yleinen reitti- ja asetuspinta, alkuperäinen SQLite-migraatio, palvelujen täydellinen vastaavuus. |
| `account`, `agent_control`, `assistant`, `data_server`, `llm_analysis`, `mcp`, `telegram`, `actions`, `events`, `logger`, `i18n`, `arguments`, `features`, `database`, `errors`, `utils`, `version`, `lib.rs`, `main.rs` | PWA käyttää omia paikallisia käyttöliittymä- ja käynnistysrajoja sekä suoria tarjoajia. | Näiden alkuperäisten toimintojen kaupankäyntipoluille tarvittava pariteetti on arvioitava erikseen. |

## Automaattinen skannaus

Skannaus löytää poolit GeckoTerminalin uusista ja trendaavista pooleista. DEX Screener päivittää asetuksista valittavat 1–30 poolia yhdellä eräpyynnöllä. Poolien löytö ajetaan kahden minuutin välein ja hintahaku vähintään 30 sekunnin välein. Käynnissä oleva salkku varaa paikat avoimille positioille myös löydön muuttuessa. Yksi IndexedDB-transaktio kirjaa kierroksen myynnit ensin ja ostot sen jälkeen. Kassa, pääomaraja ja UTC-päivän toteutuneet tappiot ovat yhteiset. Vanha käsivalintainen Paper-salkku säilyy erillään.

Kaikki uudet skannausostot tarvitsevat oikean Solana-mintin tiedot. Klassisen SPL Token -mintin minttaus- ja jäädytysvaltuuksia ei sallita. Valinnainen RugCheck estää kaupan, jos raportti puuttuu, pistemäärä ylittää asetuksen tai raportissa on danger-riski. Skanneri rajoittaa mintti- ja RugCheck-välimuistien kestoa, OHLCV-haut yhteen pooliin kierroksessa ja hinnat 64 näytteeseen per pooli. Epäonnistuneita hinta- tai tallennuskierroksia yritetään uudelleen kasvavalla odotuksella. Näkyvyyden menettäminen pysäyttää ajon. Safarin muistin ja akun käyttöä ei ole mitattu fyysisellä iPhonella.

Batch Copy Trading käyttää enintään neljää lähdelompakkoa, kahta rinnakkaista RPC-lukusarjaa ja luokittelee kunkin uuden vahvistetun transaktion kerran kaikkien seurattujen tokenien näkökulmasta. Tapahtumavälin katkeaminen estää kopio-ostot ja -myynnit, mutta hintaan perustuvat omien positioiden riskimyynnit pysyvät käytössä. Lompakkokohtainen mitoitus, suhteelliset osittaismyynnit, muita ohjelmia kattava luokittelu ja Live Copy Trading ovat vielä avoinna.

[Tiedostokohtainen inventaario ja selainvastineet](PORTING-INDEX.md)

## Live-automaation raja

Wallet Standardin yhteyden avaaminen ei anna PWA:lle yleistä allekirjoitusoikeutta. Avaimen voi pitää lompakossa ja pyytää käyttäjän hyväksynnän joka swapille. Jos hyväksyntä vie sovelluksen taustalle, uusien toimeksiantojen muodostus pysäytetään ja jo hyväksytyn tapahtuman tila täsmäytetään ennen jatkoa. Täysin itsenäinen mainnet-ajo vaatii erikseen auditoidun, ajallisesti ja rahallisesti rajatun delegoinnin, jonka swap-ohjelma hyväksyy. Pelkkä sivun salasana tai lompakon kytkentä ei toteuta sitä. Nykyinen PWA ei tallenna yksityistä avainta, eikä siinä ole mainnet-lähetystä.

Hinta-arvio käyttää käyttäjän syöttämää Jupiter-avainta vain kyseiseen HTTPS-pyyntöön. Avain poistetaan lomakkeesta eikä sitä kirjoiteta IndexedDB:hen. Tarjoajalupien luonnokseen on lisätty GeckoTerminal ja Jupiter aiempien DEX Screener- ja Solana-kohteiden lisäksi. Aiemmilla kierroksilla pilven proxy palautti CONNECT 403:n. Tässä versiossa ulkoiset pyynnöt pääsivät tarjoajille. Pää-RPC:n mainnet POST palautti HTTP 403:n, ja PublicNode käsitteli minttihaun sekä simulaation. Selainkokeessa hallitun proxyn varmenne ei ollut Chromiumille luotettu, joten ulkoiset HTTP-vastaukset todennettiin palvelimettomien sovellusmoduulien Node-ajossa ja curlilla.

## Tiedostoinventaario

```sh
git ls-files 'src/*.rs' | awk -F/ '{print $2}' | sort | uniq -c
```

## Tämän version todennus

Rustin selainmoottorille ja alkuperäisille indikaattoreille ajettiin 11 testiä. JavaScript-testejä läpäisi 12. Linuxin alkuperäinen kirjasto läpäisi lukitun offline-käännöstarkistuksen. Molemmat Chromiumin selaintestit läpäisivät staattisen paketin alihakemistossa. Ne testasivat muun muassa kynttilöistä syntyvän paperikaupan, kopioidun paperimyynnin, Live-tapahtuman tuonnin, Jupiter-hinta-arvion ja Devnet-allekirjoituksen. Ulkoiset vastaukset mallinnettiin. Testeissä ei lähetetty transaktioita. Fyysistä iPhonea tai tuotanto-Originia ei ollut todennuksessa mukana.


## Monen markkinan version todennus

19 poolia palautui aidosta GeckoTerminal-löydöstä. Kolmen poolin DEX Screener -hintaerä, Solana-mintti, 64 kynttilän OHLCV-haku ja RugCheck-yhteenveto palautuivat oikeilta tarjoajilta. Jupiter palautti aidon allekirjoittamattoman legacy-paketin. Rakennetta ja maksajaa verrattiin pyyntöön ennen RPC-simulaatiota. Varoja vailla käytetty testiosoite sai simulaatiosta tuloksen `InvalidAccountForFee`. Pakettia ei allekirjoitettu tai lähetetty. Simulaatio ja rakennetarkistus eivät yksinään ole hyväksyntä mainnet-kaupan allekirjoittamiselle.

Tämän kierroksen 20 JavaScript-testiä, 11 Rust-testiä, alkuperäisen kirjaston offline-käännöstarkistus ja kolme Chromiumin selaintestiä läpäisivät. Selaimessa käytettiin mallivastauksia, ja staattinen jakelupaketti testattiin alihakemistosta. PublicNode-WebSocket vastasi oikeaan kättelyyn HTTP 101:llä. Varsinaiset slot-ilmoitukset testattiin selaimessa mallivastauksella.


## Tämän version työlistapäivitys

- `ohlcvs/aggregator.rs` ja `strategies/conditions/indicators.rs` saivat selainvastineet UTC-aggregointiin sekä yhteisiin Rustin ATR- ja VWAP-laskuihin. Uusimman lähdekynttilän tieto voittaa duplikaatit ennen volyymin laskentaa. Alkuperäinen ketjutapahtumien OHLCV-syöttö ja aukkojen automaattinen täydennys ovat vielä avoinna.
- Copy Trading rajaa yhtäaikaiset lompakkohaut kahteen, säilyttää jokaisen lompakon tapahtumaosoittimen erikseen ja ohittaa ristiriitaiset signaalit. Puuttuva tieto estää kopiointitoimeksiannot kyseisellä kierroksella. Omien positioiden muut riskisäännöt pysyvät voimassa.
- Muokattava pooliraja koskee uusien markkinoiden lisäämistä. Raja-arvon alentaminen säilyttää jo avatun position seurannassa. Yli 20 sekuntia sitten vastaanotettua hintaa ei käytetä toimeksiantoon. Tämä kynnys kertoo paikallisen vastaanottoajan, eikä takaa tarjoajan hinnan omaa tuoreutta.
- `raptor.rs` käyttää Raptorin julkista beta-rajapintaa. Todellinen tarjouspyyntö palautti HTTP 200:n ilman selaimelle tarvittavaa `Access-Control-Allow-Origin`-otsaketta. Raptoria ei otettu selainreitittimeksi. `direct_pool.rs`:n ohjelmakohtainen tila, reititys ja swap-instruktiot ovat edelleen siirtämättä.
- Devnet-testi luo erillisen, Web Crypton viemättömän avaimen muistiin. Sovellus tarkistaa verkon genesis-hashin ja testimaksun, muodostaa ja simuloi itse rakennetun muistion, tallentaa allekirjoituksen ennen yhtä lähetysyritystä ja täsmäyttää lopputilan erikseen. Epäselvää lähetystä ei uusita. Tämä polku ei hyväksy swap-paketteja eikä Mainnet-osoitetta. Sivu ei tallenna yksityisiä avaimia.
- Oikea Devnet-RPC vahvisti verkon ja hylkäsi aidosti allekirjoitetun mutta rahoittamattoman muistion simulaatiossa virheellä `InvalidAccountForFee`. RPC-faucet on suljettu (HTTP 410), ja virallinen selainfaucet pyytää kirjautumista. Lähetys ja täsmäytys on testattu mallivastauksilla. Oikeaa Devnet-lähetystä tai Mainnet-lähetystä ei tässä ajossa tehty.
- Tuotannon Live-swapin allekirjoitus, lähetys ja toteumakirja, turvallinen automaattinen kaupankäyntivaltuutus, täydet alkuperäiset suodattimet ja dashboard-asetukset sekä fyysisen iPhonen Safari- ja akkutestit ovat yhä avoinna.
- Tämän version 26 JavaScript-testiä, 11 Rust-testiä, alkuperäisen kirjaston lukittu offline-käännöstarkistus ja neljä Chromiumin selaintestiä läpäisivät. Selainmalli tarkisti myös katkenneen Devnet-lähetyksen täsmäytyksen uudelleenlatauksen jälkeen ja Paper-ajon pysähtymisen verkkoyhteyden katketessa. GeckoTerminalin aidosta vastauksesta muodostui 64 paikallisesti aggregoitua UTC-kynttilää. Uusittu Chromiumin ulkoinen koe pysähtyi pilven välityspalvelimen varmenteeseen (`ERR_CERT_AUTHORITY_INVALID`).


## Paper-käyttövalmiuden päivitys

- Paper Trading / Live Trading, käynnistys ja pysäytys ovat samassa mobiilinäkymässä. Hätäpysäytys tallentuu IndexedDB:hen ja tarkistetaan Paper-kirjauksen ja Devnet-journaloinnin yhteydessä. Lukituksen vapautus edellyttää erillistä toimintoa. Pysäytys keskeyttää uudet toimeksiannot ja voi jättää jo lähetetyn Devnet-tapahtuman täsmäytettäväksi.
- Automaattisessa Paper-salkussa on yhteinen UTC-päivän ostoraja sekä muokattava 24 tunnin volyymisuodatin. Alkuperäisten kaupankäyntiasetusten tuonti ja täysi semanttinen vastaavuus ovat edelleen kesken.
- Selainpuun `maCross` käyttää yhteisiä Rustin EMA- ja SMA-laskuja. Nopean ja hitaan jakson, risteyksen suunnan ja katseluikkunan voi määrittää JSON-ehtopuussa. Alkuperäisen ehtopuulomakkeen suora tuonti on avoinna.
- Pages-työnkulku rakentaa manuaalisesti testatun staattisen artefaktin oletushaaralta, kun jakeluoikeudet on kuitattu. Ulkoista julkaisua ei tässä ajossa tehty. [Käyttöohje](README.md) kuvaa iPhonen kotinäyttöasennuksen.
- Devnet-faucetin tilanne on avoin. Käytä iPhonen näkymän kopiointipainikkeen antamaa julkista osoitetta ja pidä luonut sivu auki. Käyttäjän laitteella luotua yksityistä avainta ei viedä, eikä osoitetta voi määritellä etukäteen.
