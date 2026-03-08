import sharp from 'sharp';
async function test() {
  try {
    const dngBuffer = Buffer.from('dummy data');
    console.log(await sharp.format());
  } catch (e) {
    console.error(e);
  }
}
test();
