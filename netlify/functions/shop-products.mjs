// Product catalog for the NBK webshop
// Currently: personalized coffee mug with sail number

const PRODUCTS = [
  {
    id: "sail-mug",
    name: "Seilnummer-kopp",
    nameEn: "Sail Number Mug",
    description: "Personlig kaffekopp med ditt seilnummer. 500,- støtter unge seilere.",
    descriptionEn:
      "Personalized coffee mug with your sail number. 500 NOK supports young racers.",
    price: 500,
    currency: "NOK",
    image: "/img/products/sail-mug.jpg",
    personalization: {
      fields: [
        {
          name: "sailNumber",
          label: "Seilnummer",
          labelEn: "Sail Number",
          placeholder: "NOR 123",
          required: true,
          pattern: "^NOR \\d{1,4}$",
        },
      ],
    },
    causeMessage: "500,- støtter unge seilere i NBK",
    causeMessageEn: "500 NOK supports young racers in NBK",
  },
];

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  return Response.json({
    products: PRODUCTS,
    currency: "NOK",
    paymentMethod: "Vipps",
  });
};
