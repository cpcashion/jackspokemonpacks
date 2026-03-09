import sharp from 'sharp';

async function testSharp() {
    try {
        console.log('Testing sharp options and formats...');
        console.log(sharp.format);
        if (sharp.format.raw && sharp.format.raw.input.file) {
            console.log('Sharp supports raw input');
        }
        if (sharp.format.magick && sharp.format.magick.input.file) {
            console.log('Sharp supports magick input');
        }
        if (sharp.format.heif && sharp.format.heif.input.file) {
            console.log('Sharp supports HEIF/HEIC input');
        }
    } catch(err) {
        console.error(err);
    }
}
testSharp();
