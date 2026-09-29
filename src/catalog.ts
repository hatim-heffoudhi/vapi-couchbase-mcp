export type Product = {
  product_id: string;
  name: string;
  price: number;
  eta_days: number;
  tag: string;
  blurb: string;
};

export const CATALOG: Product[] = [
  {
    product_id: "headphones",
    name: "Wireless Headphones",
    price: 79.99,
    eta_days: 5,
    tag: "Audio",
    blurb: "All-day comfort and clear calls.",
  },
  {
    product_id: "sneakers",
    name: "Canvas Sneakers",
    price: 54.5,
    eta_days: 7,
    tag: "Apparel",
    blurb: "Everyday pair with a cushioned sole.",
  },
  {
    product_id: "mug-set",
    name: "Ceramic Mug Set",
    price: 48,
    eta_days: 4,
    tag: "Home",
    blurb: "Four mugs, dishwasher safe.",
  },
  {
    product_id: "linen-shirt",
    name: "Linen Shirt",
    price: 42,
    eta_days: 6,
    tag: "Apparel",
    blurb: "Light weave for warm days.",
  },
  {
    product_id: "desk-lamp",
    name: "Desk Lamp",
    price: 36,
    eta_days: 5,
    tag: "Home",
    blurb: "Warm light with a brass finish.",
  },
  {
    product_id: "wool-throw",
    name: "Wool Throw",
    price: 89,
    eta_days: 8,
    tag: "Home",
    blurb: "Heavy knit for cooler evenings.",
  },
];
