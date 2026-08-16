import dotenv from 'dotenv';
dotenv.config();

const key = process.env.CARTESIA_API_KEY;

if (!key) {
  console.log('La clé CARTESIA_API_KEY est indéfinie dans le .env !');
} else {
  console.log('Longueur de la clé :', key.length);
  console.log('Commence par :', JSON.stringify(key.substring(0, 5)));
  console.log('Se termine par :', JSON.stringify(key.substring(key.length - 5)));
  console.log('Contient des espaces ou retours à la ligne ?', /\s/.test(key));
  console.log('Contient des guillemets ?', /['"]/.test(key));
}
