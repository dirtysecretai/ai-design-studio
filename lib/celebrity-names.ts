// Static real-person name list for the content filter's "static" mode (and as
// a free pre-check in "gemini" mode — a hit here skips the paid LLM call).
//
// Curated full names + unmistakable mononyms of widely known real people:
// actors, musicians, models/influencers, athletes, politicians, streamers.
// Matching is word-boundary based on the filter's normalized prompt text, so
// "tony stark" never collides with these and ordinary first names stay usable.
// This list is a GUIDE, not a census — the LLM tier (gemini mode) is what
// catches lesser-known or newly famous people and misspellings.

const NAMES: string = `
kim kardashian,kourtney kardashian,khloe kardashian,rob kardashian,kris jenner,kylie jenner,kendall jenner,caitlyn jenner,
taylor swift,beyonce,rihanna,ariana grande,billie eilish,olivia rodrigo,dua lipa,doja cat,nicki minaj,cardi b,megan thee stallion,
lady gaga,katy perry,miley cyrus,selena gomez,demi lovato,camila cabello,shawn mendes,justin bieber,hailey bieber,
harry styles,zayn malik,niall horan,liam payne,louis tomlinson,ed sheeran,adele,sam smith,lana del rey,lorde,halsey,sza,
drake,kanye west,ye west,travis scott,kendrick lamar,j cole,post malone,lil nas x,lil wayne,jay z,eminem,snoop dogg,dr dre,
50 cent,ice cube,ice spice,tyler the creator,asap rocky,playboi carti,lil uzi vert,lil baby,dababy,21 savage,future hendrix,
bad bunny,peso pluma,karol g,rosalia,shakira,jennifer lopez,marc anthony,enrique iglesias,maluma,j balvin,
bruno mars,the weeknd,abel tesfaye,frank ocean,usher raymond,chris brown,trey songz,jason derulo,ne yo,john legend,
alicia keys,mariah carey,celine dion,whitney houston,christina aguilera,britney spears,jessica simpson,gwen stefani,
pink alecia moore,kesha sebert,avril lavigne,paramore hayley williams,hayley williams,
madonna ciccone,cher bono,dolly parton,shania twain,carrie underwood,kelly clarkson,kacey musgraves,
morgan wallen,luke combs,luke bryan,blake shelton,keith urban,tim mcgraw,faith hill,garth brooks,
zendaya,tom holland,timothee chalamet,florence pugh,sydney sweeney,jacob elordi,jenna ortega,millie bobby brown,
finn wolfhard,noah schnapp,sadie sink,anya taylor joy,emma stone,emma watson,emma roberts,emma chamberlain,
scarlett johansson,elizabeth olsen,mary kate olsen,ashley olsen,brie larson,gal gadot,margot robbie,
jennifer lawrence,jennifer aniston,jennifer garner,angelina jolie,brad pitt,leonardo dicaprio,tom cruise,
tom hanks,tom hardy,tom hiddleston,chris evans,chris hemsworth,chris pratt,chris pine,chris rock,
robert downey,robert de niro,robert pattinson,al pacino,jack nicholson,denzel washington,will smith,jada pinkett,
jaden smith,willow smith,dwayne johnson,kevin hart,ryan reynolds,ryan gosling,blake lively,hugh jackman,
george clooney,amal clooney,matt damon,ben affleck,casey affleck,jake gyllenhaal,maggie gyllenhaal,
johnny depp,amber heard,keanu reeves,nicolas cage,brendan fraser,paul rudd,mark ruffalo,mark wahlberg,
matthew mcconaughey,woody harrelson,samuel jackson,samuel l jackson,morgan freeman,anthony hopkins,ian mckellen,
patrick stewart,daniel radcliffe,rupert grint,daniel craig,pierce brosnan,idris elba,henry cavill,jason momoa,
ben barnes,cillian murphy,barry keoghan,paul mescal,andrew garfield,tobey maguire,jamie foxx,jamie dornan,
adam driver,adam sandler,jim carrey,steve carell,ryan atwood,seth rogen,jonah hill,michael cera,
michael b jordan,michael fassbender,michael douglas,michael keaton,christian bale,heath ledger,joaquin phoenix,
jared leto,jason statham,vin diesel,paul walker,jason bateman,bryan cranston,aaron paul,bob odenkirk,
pedro pascal,oscar isaac,diego luna,gael garcia,antonio banderas,javier bardem,penelope cruz,salma hayek,
sofia vergara,eva mendes,eva longoria,jessica alba,jessica biel,justin timberlake,mila kunis,ashton kutcher,
natalie portman,keira knightley,kate winslet,kate hudson,kate beckinsale,cate blanchett,julia roberts,
sandra bullock,reese witherspoon,nicole kidman,charlize theron,halle berry,zoe saldana,zoe kravitz,
lupita nyongo,viola davis,octavia spencer,regina king,taraji henson,kerry washington,gabrielle union,
anne hathaway,amy adams,amy schumer,melissa mccarthy,rebel wilson,awkwafina,constance wu,
saoirse ronan,daisy ridley,felicity jones,lily collins,lily james,dakota johnson,dakota fanning,elle fanning,
chloe grace moretz,hailee steinfeld,maude apatow,rachel zegler,jenna coleman,phoebe dynevor,
nicola coughlan,simone ashley,bridgerton rege jean page,rege jean page,jonathan bailey,
priyanka chopra,deepika padukone,alia bhatt,aishwarya rai,shah rukh khan,salman khan,amitabh bachchan,
jackie chan,jet li,donnie yen,lucy liu,michelle yeoh,ken watanabe,rain soo hyun,lee min ho,
bts jungkook,jungkook,jimin park,park jimin,kim taehyung,rm namjoon,suga min yoongi,jin seokjin,j hope hoseok,
blackpink lisa,blackpink jennie,blackpink rose,blackpink jisoo,lalisa manoban,jennie kim,
psy park jae sang,iu lee ji eun,karina yu jimin,winter kim minjeong,
cristiano ronaldo,lionel messi,neymar junior,kylian mbappe,erling haaland,mohamed salah,harry kane,
david beckham,victoria beckham,zlatan ibrahimovic,luka modric,kevin de bruyne,vinicius junior,jude bellingham,
lebron james,stephen curry,kevin durant,giannis antetokounmpo,luka doncic,nikola jokic,joel embiid,
kobe bryant,michael jordan,shaquille oneal,dennis rodman,dwyane wade,chris paul,james harden,kyrie irving,
ja morant,zion williamson,victor wembanyama,anthony edwards,jayson tatum,damian lillard,
tom brady,patrick mahomes,travis kelce,jason kelce,aaron rodgers,josh allen,joe burrow,lamar jackson,
justin herbert,dak prescott,ezekiel elliott,derrick henry,tyreek hill,odell beckham,jj watt,aaron donald,
serena williams,venus williams,naomi osaka,coco gauff,emma raducanu,iga swiatek,aryna sabalenka,
roger federer,rafael nadal,novak djokovic,carlos alcaraz,jannik sinner,andy murray,nick kyrgios,
tiger woods,rory mcilroy,jordan spieth,brooks koepka,phil mickelson,scottie scheffler,
floyd mayweather,mike tyson,canelo alvarez,jake paul,logan paul,ksi olajide,conor mcgregor,khabib nurmagomedov,
israel adesanya,jon jones,francis ngannou,ronda rousey,dana white,
lewis hamilton,max verstappen,charles leclerc,lando norris,sergio perez,fernando alonso,daniel ricciardo,
simone biles,michael phelps,usain bolt,katie ledecky,sha carri richardson,noah lyles,
donald trump,melania trump,ivanka trump,barron trump,joe biden,jill biden,hunter biden,kamala harris,
barack obama,michelle obama,hillary clinton,bill clinton,george bush,ron desantis,gavin newsom,
bernie sanders,alexandria ocasio cortez,nancy pelosi,mitch mcconnell,marjorie taylor greene,
vladimir putin,volodymyr zelensky,emmanuel macron,justin trudeau,boris johnson,rishi sunak,keir starmer,
angela merkel,olaf scholz,xi jinping,kim jong un,narendra modi,benjamin netanyahu,
elon musk,grimes boucher,jeff bezos,lauren sanchez,mark zuckerberg,priscilla chan,bill gates,melinda gates,
warren buffett,tim cook,sundar pichai,satya nadella,sam altman,jensen huang,steve jobs,jack dorsey,
mr beast,mrbeast,jimmy donaldson,pewdiepie,felix kjellberg,markiplier,jacksepticeye,
pokimane,imane anys,valkyrae,amouranth,kaitlyn siragusa,belle delphine,corinna kopf,
addison rae,charli damelio,dixie damelio,bella poarch,khaby lame,james charles,jeffree star,
nikocado avocado,trisha paytas,tana mongeau,david dobrik,emma chamberlain,alix earle,
kai cenat,ishowspeed,darren watkins,adin ross,xqc lengyel,felix lengyel,ninja blevins,tyler blevins,
andrew tate,tristan tate,jordan peterson,joe rogan,ben shapiro,candace owens,hasan piker,
paris hilton,nicole richie,lindsay lohan,britney jean,pamela anderson,carmen electra,
megan fox,machine gun kelly,colson baker,pete davidson,ariana madix,tom sandoval,
kate middleton,prince william,prince harry,meghan markle,queen elizabeth,king charles,princess diana,
gigi hadid,bella hadid,cara delevingne,cindy crawford,kaia gerber,naomi campbell,tyra banks,
heidi klum,adriana lima,alessandra ambrosio,miranda kerr,karlie kloss,ashley graham,emily ratajkowski,
hailey baldwin,irina shayk,barbara palvin,josephine skriver,candice swanepoel,doutzen kroes,
mia khalifa,lana rhoades,riley reid,abella danger,eva elfie,johnny sins,asa akira,sasha grey,
stormy daniels,jenna jameson,ron jeremy,
oprah winfrey,ellen degeneres,jimmy fallon,jimmy kimmel,stephen colbert,seth meyers,trevor noah,
john oliver,bill maher,conan obrien,james corden,david letterman,jay leno,howard stern,
anderson cooper,tucker carlson,sean hannity,rachel maddow,don lemon,megyn kelly,piers morgan,
gordon ramsay,jamie oliver,guy fieri,bobby flay,martha stewart,snoop martha,
kris humphries,scott disick,travis barker,kourtney barker,blac chyna,tyga stevenson,
amber rose,wiz khalifa,offset cephus,quavo marshall,takeoff kirshnik,
danny devito,arnold schwarzenegger,sylvester stallone,bruce willis,demi moore,mel gibson,
harrison ford,mark hamill,carrie fisher,ewan mcgregor,hayden christensen,natalie wood,
clint eastwood,kurt russell,goldie hawn,kevin costner,russell crowe,gerard butler,
liam neeson,colin farrell,colin firth,hugh grant,jude law,orlando bloom,katy bloom,
eric andre,zach galifianakis,bradley cooper,irina cooper,gigi cooper,
sacha baron cohen,isla fisher,ricky gervais,rowan atkinson,simon cowell,gordon cowell,
david attenborough,morgan attenborough,bear grylls,steve irwin,bindi irwin,
whoopi goldberg,joy behar,kelly ripa,ryan seacrest,mario lopez,al roker,hoda kotb,
dr phil mcgraw,dr oz mehmet,judge judy,steve harvey,wayne brady,nick cannon,mariah cannon,
robin williams,betty white,carol burnett,dick van dyke,julie andrews,angela lansbury,
audrey hepburn,marilyn monroe,elvis presley,frank sinatra,dean martin,sammy davis,
john lennon,paul mccartney,ringo starr,george harrison,mick jagger,keith richards,
freddie mercury,david bowie,prince rogers nelson,michael jackson,janet jackson,tito jackson,
stevie wonder,elton john,rod stewart,phil collins,sting sumner,bono vox,dave grohl,
kurt cobain,courtney love,eddie vedder,chris cornell,axl rose,slash hudson,ozzy osbourne,
sharon osbourne,kelly osbourne,jack osbourne,gene simmons,paul stanley,alice cooper,
metallica james hetfield,james hetfield,lars ulrich,kirk hammett,
bruce springsteen,billy joel,bob dylan,neil young,joni mitchell,stevie nicks,lindsey buckingham,
johnny cash,june carter,willie nelson,waylon jennings,kris kristofferson,
tupac shakur,notorious big,biggie smalls,nas jones,dmx simmons,ja rule,
missy elliott,lauryn hill,erykah badu,mary j blige,queen latifah,lil kim,foxy brown,
tina turner,aretha franklin,diana ross,gladys knight,patti labelle,chaka khan,
bob marley,ziggy marley,peter tosh,jimmy cliff,sean paul,shaggy orville,
daddy yankee,don omar,nicky jam,ozuna rosado,anuel aa,rauw alejandro,
billie joe armstrong,tre cool,mike dirnt,blink travis,tom delonge,mark hoppus,
avicii bergling,calvin harris,david guetta,martin garrix,marshmello christopher,deadmau5 zimmerman,
skrillex moore,diplo pentz,steve aoki,tiesto verwest,armin van buuren,alan walker,
zedd anton,kygo gorvell,illenium miller,porter robinson,madeon hugo,
grimes claire,bjork gudmundsdottir,fka twigs,charli xcx,pinkpantheress,
ice spice gaston,glorilla woods,latto stephens,saweetie harper,coi leray,flo milli,
central cee,stormzy omari,dave santan,aitch harrison,skepta adenuga,
jorja smith,mabel mcvey,raye keen,ella mai,jess glynne,anne marie,rita ora,jessie j,
tion wayne,headie one,digga d,unknown t,abra cadabra,
sabrina carpenter,gracie abrams,tate mcrae,madison beer,nessa barrett,conan gray,
troye sivan,lauv leff,jeremy zucker,chelsea cutler,quinn xcii,
noah kahan,zach bryan,jelly roll,bailey zimmerman,hardy hunter,lainey wilson,
maren morris,kelsea ballerini,kane brown,thomas rhett,dan shay,old dominion,
hozier byrne,dermot kennedy,niall breslin,lewis capaldi,tom grennan,george ezra,
`

// Compiled once at module load: normalized names → word-boundary regexes.
// Single-token entries are required to be ≥4 chars to avoid generic collisions.
const COMPILED_NAMES: { name: string; re: RegExp }[] = NAMES
  .split(',')
  .map(n => n.trim().toLowerCase().replace(/\s+/g, ' '))
  .filter(n => n.length >= 4 && /^[a-z ]+$/.test(n))
  .map(name => ({ name, re: new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`) }))

/**
 * Checks an already-NORMALIZED prompt (see content-filter normalize()) against
 * the static real-person name list. Returns the matched name or null.
 */
export function celebrityNameCheck(normalizedPrompt: string): string | null {
  for (const { name, re } of COMPILED_NAMES) {
    if (re.test(normalizedPrompt)) return name
  }
  return null
}

export const CELEBRITY_NAME_COUNT = COMPILED_NAMES.length
