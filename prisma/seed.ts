/**
 * Demo catalog seed — idempotent: safe to run repeatedly (products are
 * matched by name, categories by name, admin by email).
 *
 *   bunx prisma db seed
 *
 * Images are verified Unsplash placeholders on the app's image allowlist —
 * swap them for real product photography when you have it.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const img = (id: string) => `https://images.unsplash.com/photo-${id}?w=1200&q=80`;

const DEMO_ADMIN = {
  email: "admin@vendary.test",
  // Demo-only credential for local clones — change or remove for any real deploy.
  password: "Admin@1234",
};

const categories = [
  {
    name: "Art",
    products: [
      {
        name: "Madhubani Fish Motif Painting",
        price: 2499,
        stockQty: 12,
        tag: "Madhubani",
        isFeatured: true,
        thumbnail: img("1579783902614-a3fb3927b6a5"),
        images: [img("1579783902614-a3fb3927b6a5"), img("1541961017774-22349e4a1262")],
        shortDescription: "Hand-painted Madhubani folk art on handmade paper, fish motif symbolising prosperity.",
        description:
          "An authentic Madhubani painting from the Mithila region of Bihar, hand-painted with natural dyes and bamboo-twig brushes. The fish motif is a traditional symbol of prosperity and good fortune. Each piece is signed by the artist and ships unframed, rolled in a protective tube.",
      },
      {
        name: "Warli Village Wall Art",
        price: 1899,
        stockQty: 18,
        tag: "Warli",
        thumbnail: img("1513364776144-60967b0f800f"),
        images: [img("1513364776144-60967b0f800f"), img("1541961017774-22349e4a1262")],
        shortDescription: "Tribal Warli art in white rice-paste pigment on earth-toned canvas.",
        description:
          "Warli is the tribal art of the Sahyadri foothills, painted by women in white rice-paste pigment. This canvas shows a village celebration — tarpa dancers, huts and farm scenes in the iconic stick-figure style. Arrives ready to frame.",
      },
      {
        name: "Pattachitra Peacock Artwork",
        price: 4999,
        stockQty: 6,
        tag: "Pattachitra",
        thumbnail: img("1541961017774-22349e4a1262"),
        images: [img("1541961017774-22349e4a1262"), img("1579783902614-a3fb3927b6a5")],
        shortDescription: "Intricate Odisha Pattachitra with natural pigments on treated cloth.",
        description:
          "Pattachitra is one of India's oldest living painting traditions. This peacock composition is painted on cloth treated with tamarind gum and chalk, using mineral and vegetable pigments, then finished with a lacquer sheen. A heirloom-grade piece from master painters in Raghurajpur.",
      },
    ],
  },
  {
    name: "Toys",
    products: [
      {
        name: "Channapatna Wooden Spinning Tops",
        price: 349,
        stockQty: 40,
        tag: "Channapatna",
        thumbnail: img("1558060370-d644479cb6f7"),
        images: [img("1558060370-d644479cb6f7"), img("1605883705077-8d3d3cebe78c")],
        shortDescription: "Set of four lacquered spinning tops, food-safe colours, non-toxic.",
        description:
          "From Karnataka's toy town: hand-turned hale wood spinning tops finished with natural lac and vegetable dyes. Food-safe, splinter-free and durable enough to be handed down. Set of four in assorted colours.",
      },
      {
        name: "Kondapalli Carved Bull Set",
        price: 1299,
        stockQty: 15,
        tag: "Kondapalli",
        thumbnail: img("1605883705077-8d3d3cebe78c"),
        images: [img("1605883705077-8d3d3cebe78c"), img("1558060370-d644479cb6f7")],
        shortDescription: "Hand-carved Kondapalli bulls in soft treewood, natural tamarind-seed finish.",
        description:
          "The toy-makers of Kondapalli, Andhra Pradesh, have carved this style for four centuries. Each bull is shaped from lichteria poniki treewood, painted with natural colours, and finished with tamarind-seed paste. Set of three bulls in graduated sizes.",
      },
      {
        name: "Sawantwadi Kitchen Play Set",
        price: 1499,
        stockQty: 10,
        tag: "Sawantwadi",
        thumbnail: img("1522202176988-66273c2fd55f"),
        images: [img("1522202176988-66273c2fd55f"), img("1558060370-d644479cb6f7")],
        shortDescription: "Hand-painted wooden mini kitchen set for pretend play, ages 3+.",
        description:
          "A hand-painted wooden kitchen play set from Sawantwadi, Maharashtra — miniature pots, pans, rolling pin and stove, lacquered in classic fruit motifs. Encourages open-ended pretend play with zero plastic and zero batteries.",
      },
    ],
  },
  {
    name: "Pottery",
    products: [
      {
        name: "Jaipur Blue Pottery Vase",
        price: 1199,
        stockQty: 20,
        tag: "Jaipur Blue",
        isFeatured: true,
        thumbnail: img("1578500494198-246f612d3b3d"),
        images: [img("1578500494198-246f612d3b3d"), img("1586023492125-27b2c045efd7")],
        shortDescription: "Iconic Turquoise-Persian glazed vase, quartz-based, hand-painted floral.",
        description:
          "Jaipur's signature blue pottery — a quartz-based, low-temperature glazed ware with Persian roots. Hand-painted floral vine in cobalt on the classic turquoise ground. Decorative use; each piece varies slightly by hand.",
      },
      {
        name: "Khurja Ceramic Serving Bowl",
        price: 799,
        stockQty: 25,
        tag: "Khurja",
        thumbnail: img("1586023492125-27b2c045efd7"),
        images: [img("1586023492125-27b2c045efd7"), img("1578500494198-246f612d3b3d")],
        shortDescription: "Food-safe stoneware bowl from Khurja's centuries-old kilns.",
        description:
          "Khurja in Uttar Pradesh has fired ceramics since the Mughal era. This stoneware bowl is lead-free, food-safe, and dishwasher friendly — a generous centrepiece for salads, noodles or fruit. 24 cm diameter.",
      },
      {
        name: "Longpi Black Pottery Kettle",
        price: 2199,
        stockQty: 8,
        tag: "Longpi",
        thumbnail: img("1565193566173-7a0ee3dbe261"),
        images: [img("1565193566173-7a0ee3dbe261"), img("1586023492125-27b2c045efd7")],
        shortDescription: "Stone-pottery kettle from Manipur, fired without a wheel or glaze.",
        description:
          "Longpi ha is a serpentine-stone pottery made only in Longpi village, Manipur — shaped entirely by hand without a potter's wheel, polished with wild machee leaves, and fired with straw. The matte black finish suits both stovetop use and the table.",
      },
    ],
  },
  {
    name: "Weaves",
    products: [
      {
        name: "Kashmiri Pashmina Shawl",
        price: 8999,
        stockQty: 6,
        tag: "Pashmina",
        isFeatured: true,
        thumbnail: img("1528459801416-a9e53bbf4e17"),
        images: [img("1528459801416-a9e53bbf4e17"), img("1604176354204-9268737828e4")],
        shortDescription: "Featherweight hand-spun pashmina, Kani border, GI-certified wool.",
        description:
          "Woven on a pit loom in Srinagar from GI-certified Changthangi pashmina wool — featherweight, warm and impossibly soft. The Kani-style border is woven, not printed. Comes with a fabric-provenance card. 100 × 200 cm.",
      },
      {
        name: "Pochampally Ikat Cotton Saree",
        price: 3499,
        stockQty: 12,
        tag: "Ikat",
        thumbnail: img("1604176354204-9268737828e4"),
        images: [img("1604176354204-9268737828e4"), img("1610701596007-11502861dcfa")],
        shortDescription: "Double-ikat telia rumal saree, yarn-dyed in natural indigo.",
        description:
          "Pochampally double-ikat is resist-dyed at the yarn stage so the pattern emerges blurred-edge perfect on the loom. This telia rumal design uses natural indigo and ivory cotton, 6.3 m with blouse piece, from weaver cooperatives in Telangana.",
      },
      {
        name: "Kalamkari Bed Runner",
        price: 2799,
        stockQty: 14,
        tag: "Kalamkari",
        thumbnail: img("1610701596007-11502861dcfa"),
        images: [img("1610701596007-11502861dcfa"), img("1528459801416-a9e53bbf4e17")],
        shortDescription: "Hand block-printed kalamkari cotton runner, myrobalan and madder dyes.",
        description:
          "Kalamkari literally means 'pen work'. This bed runner is block-printed and hand-painted with myrobalan, madder root and iron-rust inks, then washed in river sand — the traditional Andhra process. 55 × 240 cm, preshrunk cotton.",
      },
    ],
  },
  {
    name: "Jewelry",
    products: [
      {
        name: "Meenakari Enamel Earrings",
        price: 1599,
        stockQty: 16,
        tag: "Meenakari",
        thumbnail: img("1599643478518-a784e5dc4c8f"),
        images: [img("1599643478518-a784e5dc4c8f"), img("1515562141207-7a88fb7ce338")],
        shortDescription: "Jaipuri meenakari jhumkas in brass with hand-fired enamel.",
        description:
          "Meenakari is the Mughal-era art of firing coloured enamel onto metal. These jhumka earrings are brass-based, hand-enameled in Jaipur's Johari Bazaar tradition, with nickel-free posts. Weight-light for all-day wear.",
      },
      {
        name: "Temple Silver Necklace",
        price: 6499,
        stockQty: 5,
        tag: "Temple",
        isFeatured: true,
        thumbnail: img("1515562141207-7a88fb7ce338"),
        images: [img("1515562141207-7a88fb7ce338"), img("1611591437281-460bfbe1220a")],
        shortDescription: "92.5 sterling silver temple-work necklace from Nagercoil artisans.",
        description:
          "South Indian temple jewellery repoussé work, cast and chased in 92.5 sterling silver by fifth-generation artisans. The Lakshmi-coin motif strung on a braided silver chain. Hallmarked; arrives in a cotton pouch.",
      },
      {
        name: "Bidriware Cufflinks",
        price: 1899,
        stockQty: 11,
        tag: "Bidriware",
        thumbnail: img("1611591437281-460bfbe1220a"),
        images: [img("1611591437281-460bfbe1220a"), img("1599643478518-a784e5dc4c8f")],
        shortDescription: "Gunmetal Bidriware cufflinks with silver inlay, GI-crafted in Bidar.",
        description:
          "Bidriware from Bidar, Karnataka: a blackened zinc-copper alloy inlaid with pure silver wire, the black finish induced by soil unique to Bidar fort — a GI-protected craft since the 14th century. Rounded cufflinks in the classic ashoka-leaf motif.",
      },
    ],
  },
];

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_ADMIN.password, 10);
  const admin = await prisma.user.upsert({
    where: { email: DEMO_ADMIN.email },
    update: { role: "ADMIN" },
    create: {
      email: DEMO_ADMIN.email,
      name: "Vendary Demo Admin",
      role: "ADMIN",
      emailVerified: new Date(),
      password: passwordHash,
    },
  });

  let productCount = 0;
  for (const { name: categoryName, products } of categories) {
    const category = await prisma.category.upsert({
      where: { name: categoryName },
      update: {},
      create: { name: categoryName },
    });

    for (const product of products) {
      const existing = await prisma.product.findFirst({
        where: { name: product.name },
        select: { id: true },
      });

      const data = {
        name: product.name,
        price: product.price,
        stockQty: product.stockQty,
        tag: product.tag,
        isFeatured: product.isFeatured,
        shortDescription: product.shortDescription,
        description: product.description,
        availability: "IN_STOCK" as const,
        shippingTime: "5-10 business days",
        category: { connect: { id: category.id } },
        user: { connect: { id: admin.id } },
        thumbnail: product.thumbnail,
      };

      if (existing) {
        await prisma.product.update({
          where: { id: existing.id },
          data: {
            ...data,
            images: {
              deleteMany: {},
              create: product.images.map((url, index) => ({
                url,
                isMain: index === 0,
              })),
            },
          },
        });
      } else {
        await prisma.product.create({
          data: {
            ...data,
            images: {
              create: product.images.map((url, index) => ({
                url,
                isMain: index === 0,
              })),
            },
          },
        });
      }
      productCount += 1;
    }
  }

  console.log(
    `Seeded ${categories.length} categories and ${productCount} products.\n` +
      `Demo admin login: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password} (demo-only credential).`
  );
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
